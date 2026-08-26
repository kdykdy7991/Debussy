/**
 * /ui-preview/agent-design
 *
 * Phase 2: 把已有项目的真实业务能力（AgentApi / AppApi / LlmApi /
 * AgentState 状态机 / PublishDrawer）接入到 Phase 1 确认过的视觉页面里。
 *
 * 边界（重要）：
 *  - **DOM / CSS / 视觉规格完全保留 Phase 1 的样子**，只替换数据源和 handler
 *  - 旧 Agent 设计页（agents/agent-*.tsx）的 JSX 与 CSS 一行没抄
 *  - 仅复用非视觉代码：types、API 客户端、状态机 reducer、PublishDrawer 组件
 *  - 后端不可达时（dev 环境无 proxy），自动降级为 mock 并在 Header 标 "示例数据"
 *  - 旧页里**只读 / 没法编辑**的字段（name、description、avatar 图像），这里
 *    仍然按视觉显示为可输入框，但保存时不会被发送（因为后端无 update 接口）
 *  - 旧页里**根本不存在的字段**（欢迎语、建议问题），后端目前没有对应能力，
 *    保留 Phase 1 的 mock 状态和 UI
 */

import type { AgentConfigSnapshot, AgentPublicId } from "@earendil-works/pi-protocol";
import { type ChangeEvent, type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
	type AgentState,
	beginSave,
	buildSaveRequest,
	editDraft,
	initialAgentState,
	saveFailed,
	saveSucceeded,
} from "../admin/agents/agent-state.ts";
import { AgentApi, AgentApiError } from "../admin/api/agent-api.ts";
import { AppApi } from "../admin/api/app-api.ts";
import { newIdempotencyKey } from "../admin/api/idempotency.ts";
import { PublishDrawer } from "../admin/apps/publish-drawer.tsx";
import { AdminAuthProvider, useAdminAuth } from "../admin/auth/admin-auth-context.tsx";
import { AdminAuthController } from "../publishing/auth-controller.ts";
import "./agent-design.css";

// ────────────────────────────────────────────────────────────────────────────
// Auth + API client hook（避免引入完整 AdminAuthProvider — 预览页要能在
// dev 无 proxy 场景下也能跑，fetchSession 失败不能清掉 controller 的 token）
// ────────────────────────────────────────────────────────────────────────────

function useAdminController(): AdminAuthController {
	return useMemo(() => {
		const ctrl = new AdminAuthController();
		// 与 AdminAuthProvider 同样的占位 token；dev 下 vite proxy 替换、prod 下网关替换
		ctrl.connect("dev-bypass-placeholder");
		return ctrl;
	}, []);
}

function useApiClients(controller: AdminAuthController) {
	return useMemo(
		() => ({
			agent: new AgentApi({ auth: controller }),
			app: new AppApi({ auth: controller }),
		}),
		[controller],
	);
}

function useAgentIdFromUrl(): AgentPublicId {
	return useMemo(() => {
		if (typeof window === "undefined") {
			return "agent_00000000-0000-0000-0000-000000000000" as AgentPublicId;
		}
		const params = new URLSearchParams(window.location.search);
		const fromQuery = params.get("agentId");
		if (fromQuery && fromQuery.startsWith("agent_")) {
			return fromQuery as AgentPublicId;
		}
		return "agent_00000000-0000-0000-0000-000000000000" as AgentPublicId;
	}, []);
}

// ────────────────────────────────────────────────────────────────────────────
// Mock data — 仅在「后端不可达」时使用作为降级
// 字段与 Phase 1 完全一致，方便视觉回归
// ────────────────────────────────────────────────────────────────────────────

const MOCK_AGENT = {
	name: "合同审查助手",
	description: "专业的合同审查 AI 助手，帮助法务团队快速识别风险条款、合规问题，并提供修改建议。",
	welcome:
		"您好！我是合同审查助手。\n\n您可以上传合同文件，我会帮您识别潜在风险、合规问题，并给出修改建议。\n\n请告诉我您需要关注的重点，或直接上传文件开始审查。",
	suggestedQuestions: [
		"请帮我审查这份合同的风险点",
		"合同中是否存在不利于我方的条款？",
		"关于违约责任条款，有什么修改建议？",
	],
	revisionLabel: "r12",
	revisionAt: "2025-05-26 14:32",
};

const MOCK_CHAT = {
	userMessage: "请帮我审查这份服务合作协议的风险点。",
	thinkingDurationSec: 12,
	thinkingBody: `我已对您上传的《服务合作协议》进行了审查，发现以下潜在风险点：`,
	thinkingItems: [
		{
			title: "违约责任条款",
			body: "第 8.2 条约定的违约金比例过高，可能超出合理范围，建议调整为不超过实际损失的 30%。",
		},
		{
			title: "知识产权归属",
			body: "第 5.1 条中未明确约定交付成果的知识产权归属，可能导致后续纠纷。",
		},
	],
	afterThinking: "如需查看详细分析，请告诉我或上传其他合同文件。",
	toolCall: {
		name: "合同风险分析",
		file: { name: "服务合作协议_v2.1.pdf", size: "1.2 MB" },
		categories: ["违约责任", "知识产权", "保密条款", "终止条款"],
		elapsedSec: "18.4",
	},
};

// ────────────────────────────────────────────────────────────────────────────
// Icons (inline SVG; 自包含，不引用任何项目现有 icon 组件)
// ────────────────────────────────────────────────────────────────────────────

function Icon({ name, size = 18 }: { name: string; size?: number }) {
	const common = {
		width: size,
		height: size,
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.6,
		strokeLinecap: "round" as const,
		strokeLinejoin: "round" as const,
	};
	switch (name) {
		case "home":
			return (
				<svg {...common}>
					<path d="M3 11.5 12 4l9 7.5" />
					<path d="M5 10.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9.5" />
				</svg>
			);
		case "agent":
			return (
				<svg {...common}>
					<rect x="4" y="7" width="16" height="12" rx="2" />
					<path d="M12 3v4" />
					<circle cx="12" cy="3" r="0.5" fill="currentColor" />
					<circle cx="9" cy="13" r="1.2" />
					<circle cx="15" cy="13" r="1.2" />
					<path d="M9.5 16.5h5" />
				</svg>
			);
		case "chat":
			return (
				<svg {...common}>
					<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5V14a2.5 2.5 0 0 1-2.5 2.5H12l-4 3.5V16.5H6.5A2.5 2.5 0 0 1 4 14V6.5Z" />
				</svg>
			);
		case "publish":
			return (
				<svg {...common}>
					<path d="M4 20v-2a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v2" />
					<path d="M12 12V4" />
					<path d="m8 8 4-4 4 4" />
				</svg>
			);
		case "evaluate":
			return (
				<svg {...common}>
					<path d="M5 21V10" />
					<path d="M5 10l4-4 4 4" />
					<path d="M5 10h4" />
					<path d="M11 21l2-12 2 12" />
					<path d="M11 17h4" />
					<path d="M17 21l3-9 3 9" />
					<path d="M17 17h6" />
				</svg>
			);
		case "monitor":
			return (
				<svg {...common}>
					<circle cx="11" cy="11" r="6.5" />
					<path d="m20 20-4.5-4.5" />
				</svg>
			);
		case "audit":
			return (
				<svg {...common}>
					<rect x="4" y="3" width="16" height="18" rx="2" />
					<path d="M8 8h8" />
					<path d="M8 12h8" />
					<path d="M8 16h5" />
				</svg>
			);
		case "arrow-left":
			return (
				<svg {...common}>
					<path d="M15 5l-7 7 7 7" />
				</svg>
			);
		case "more":
			return (
				<svg {...common}>
					<circle cx="5" cy="12" r="1.4" fill="currentColor" />
					<circle cx="12" cy="12" r="1.4" fill="currentColor" />
					<circle cx="19" cy="12" r="1.4" fill="currentColor" />
				</svg>
			);
		case "drag":
			return (
				<svg {...common} strokeWidth={1.4}>
					<circle cx="9" cy="6" r="0.9" fill="currentColor" />
					<circle cx="15" cy="6" r="0.9" fill="currentColor" />
					<circle cx="9" cy="12" r="0.9" fill="currentColor" />
					<circle cx="15" cy="12" r="0.9" fill="currentColor" />
					<circle cx="9" cy="18" r="0.9" fill="currentColor" />
					<circle cx="15" cy="18" r="0.9" fill="currentColor" />
				</svg>
			);
		case "close":
			return (
				<svg {...common}>
					<path d="M6 6l12 12" />
					<path d="M18 6 6 18" />
				</svg>
			);
		case "refresh":
			return (
				<svg {...common}>
					<path d="M20 12a8 8 0 1 1-2.34-5.66" />
					<path d="M20 4v5h-5" />
				</svg>
			);
		case "upload":
			return (
				<svg {...common}>
					<path d="M12 16V4" />
					<path d="m7 9 5-5 5 5" />
					<path d="M4 20h16" />
				</svg>
			);
		case "paperclip":
			return (
				<svg {...common}>
					<path d="M21 11.5 12.2 20.3a5 5 0 0 1-7-7L13.6 4.9a3.5 3.5 0 0 1 4.9 4.9l-8.5 8.5a2 2 0 0 1-2.8-2.8l7.8-7.8" />
				</svg>
			);
		case "emoji":
			return (
				<svg {...common}>
					<circle cx="12" cy="12" r="9" />
					<circle cx="9" cy="10" r="0.8" fill="currentColor" />
					<circle cx="15" cy="10" r="0.8" fill="currentColor" />
					<path d="M8.5 14.5c1 1.4 2.2 2 3.5 2s2.5-.6 3.5-2" />
				</svg>
			);
		case "send":
			return (
				<svg {...common} fill="currentColor" stroke="none">
					<path d="M3.4 3.4c-.4.4-.5 1-.3 1.5l3.1 9.4c.1.4.5.6.9.5l4.7-1.1a.5.5 0 0 0 .2-.9L6.4 8.3a.5.5 0 0 1 0-.9l12.5-6.4c.5-.3 1.1.3.8.8L13.3 14a.5.5 0 0 0 .9.3l1.6-3.4 4.3-1c.5-.1.9-.5 1-1l.9-4.1c.2-.5 0-1.1-.4-1.5Z" />
				</svg>
			);
		case "check":
			return (
				<svg {...common} strokeWidth={2}>
					<path d="M5 12.5 10 17l9-10" />
				</svg>
			);
		case "chevron-up":
			return (
				<svg {...common}>
					<path d="M6 15l6-6 6 6" />
				</svg>
			);
		case "chevron-right":
			return (
				<svg {...common}>
					<path d="M9 6l6 6-6 6" />
				</svg>
			);
		case "plus":
			return (
				<svg {...common}>
					<path d="M12 5v14" />
					<path d="M5 12h14" />
				</svg>
			);
		case "edit":
			return (
				<svg {...common}>
					<path d="M4 20h4l10-10-4-4L4 16v4Z" />
					<path d="m13 7 4 4" />
				</svg>
			);
		case "scale":
			return (
				<svg {...common} strokeWidth={1.4}>
					<path d="M12 4v16" />
					<path d="M5 20h14" />
					<path d="M7 7h10" />
					<path d="M3 11l3-4h0l3 4" />
					<path d="M3 11h6" />
					<path d="M4.5 9.5h4" />
					<path d="M15 11l3-4h0l3 4" />
					<path d="M15 11h6" />
					<path d="M16.5 9.5h4" />
				</svg>
			);
		case "file":
			return (
				<svg {...common}>
					<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
					<path d="M14 3v4h4" />
				</svg>
			);
		case "chevron-down":
			return (
				<svg {...common}>
					<path d="M6 9l6 6 6-6" />
				</svg>
			);
		default:
			return null;
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Page-level chrome
// ────────────────────────────────────────────────────────────────────────────

function BrandMark({ size = 22 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
			<path d="M5 5h14L5 19h14" stroke="#f3efe6" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function NavRail() {
	const items: { id: string; label: string; icon: string; active?: boolean }[] = [
		{ id: "overview", label: "总览", icon: "home" },
		{ id: "agent", label: "Agent", icon: "agent", active: true },
		{ id: "chat", label: "Chat", icon: "chat" },
		{ id: "publish", label: "发布", icon: "publish" },
		{ id: "evaluate", label: "评测", icon: "evaluate" },
		{ id: "monitor", label: "监控", icon: "monitor" },
		{ id: "audit", label: "审计", icon: "audit" },
	];
	return (
		<aside className="adp-rail">
			<div className="adp-rail__brand">
				<BrandMark />
				<span className="adp-rail__brand-name">Debussy</span>
			</div>
			<nav className="adp-rail__nav">
				{items.map((it) => (
					<button
						key={it.id}
						type="button"
						className={`adp-rail__item${it.active ? " is-active" : ""}`}
						title={it.label}
					>
						<span className="adp-rail__icon">
							<Icon name={it.icon} size={18} />
						</span>
						<span className="adp-rail__label">{it.label}</span>
					</button>
				))}
			</nav>
			<div className="adp-rail__user">
				<div className="adp-rail__avatar">A</div>
				<div className="adp-rail__user-text">
					<div className="adp-rail__tenant">Acme Corp</div>
					<div className="adp-rail__role">管理员</div>
				</div>
				<span className="adp-rail__caret">
					<Icon name="chevron-down" size={14} />
				</span>
			</div>
		</aside>
	);
}

interface TopHeaderProps {
	readonly title: string;
	readonly statusBadge: { label: string; tone: "saved" | "dirty" | "saving" | "error" };
	readonly revisionLabel: string;
	readonly revisionAt: string;
	readonly unsavedNote: string | null;
	readonly dataSourceBadge: { label: string; tone: "live" | "mock" };
	readonly saveDisabled: boolean;
	readonly publishDisabled: boolean;
	readonly saveTitle: string;
	readonly onSave: () => void;
	readonly onPublish: () => void;
}

function TopHeader({
	title,
	statusBadge,
	revisionLabel,
	revisionAt,
	unsavedNote,
	dataSourceBadge,
	saveDisabled,
	publishDisabled,
	saveTitle,
	onSave,
	onPublish,
}: TopHeaderProps) {
	return (
		<header className="adp-header">
			<div className="adp-header__left">
				<button type="button" className="adp-header__back">
					<Icon name="arrow-left" size={14} />
					<span>返回 Agent 列表</span>
				</button>
				<div className="adp-header__divider" />
				<h1 className="adp-header__title">{title}</h1>
				<span
					className={`adp-header__saved adp-header__badge--${statusBadge.tone}`}
					title={statusBadge.tone === "error" ? "上次保存失败，详见保存按钮提示" : undefined}
				>
					<span className="adp-header__saved-dot" />
					{statusBadge.label}
				</span>
				<span className="adp-header__revision">
					Revision: {revisionLabel} （{revisionAt}）
				</span>
				<span
					className={`adp-header__datasource adp-header__datasource--${dataSourceBadge.tone}`}
					title={
						dataSourceBadge.tone === "live"
							? "本页数据来自 Control API 实时返回"
							: "后端不可达，使用 Phase 1 视觉示例数据"
					}
				>
					<span className="adp-header__datasource-dot" />
					{dataSourceBadge.label}
				</span>
				{unsavedNote ? (
					<span className="adp-header__unsaved">
						<span className="adp-header__unsaved-dot" />
						{unsavedNote}
					</span>
				) : null}
			</div>
			<div className="adp-header__right">
				<button
					type="button"
					className="adp-btn adp-btn--ghost"
					onClick={onSave}
					disabled={saveDisabled}
					title={saveTitle}
				>
					保存草稿
				</button>
				<button
					type="button"
					className="adp-btn adp-btn--solid"
					onClick={onPublish}
					disabled={publishDisabled}
					title={publishDisabled ? "保存草稿后即可发布" : "跳转到发布流程"}
				>
					发布
				</button>
				<button type="button" className="adp-iconbtn" aria-label="更多">
					<Icon name="more" size={18} />
				</button>
			</div>
		</header>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Left secondary nav
// ────────────────────────────────────────────────────────────────────────────

const SECONDARY_NAV: { id: string; label: string; icon: string }[] = [
	{ id: "basic", label: "基本信息", icon: "edit" },
	{ id: "instruction", label: "指令", icon: "edit" },
	{ id: "model", label: "模型与思考强度", icon: "agent" },
	{ id: "tools", label: "工具", icon: "evaluate" },
	{ id: "kb", label: "知识库", icon: "file" },
	{ id: "vars", label: "变量", icon: "edit" },
	{ id: "safety", label: "安全策略", icon: "audit" },
	{ id: "opening", label: "开场白与建议问题", icon: "chat" },
];

function SecondaryNav() {
	return (
		<nav className="adp-subnav">
			<div className="adp-subnav__title">Agent 设计</div>
			<ul className="adp-subnav__list">
				{SECONDARY_NAV.map((it, i) => (
					<li key={it.id}>
						<button type="button" className={`adp-subnav__item${i === 0 ? " is-active" : ""}`}>
							<span className="adp-subnav__icon">
								<Icon name={it.icon} size={16} />
							</span>
							<span>{it.label}</span>
						</button>
					</li>
				))}
			</ul>
		</nav>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Center config editor
// ────────────────────────────────────────────────────────────────────────────

function FieldLabel({ required, hint, children }: { required?: boolean; hint?: string; children: ReactNode }) {
	return (
		<div className="adp-field__label">
			{required ? <span className="adp-field__req">*</span> : null}
			{children}
			{hint ? <span className="adp-field__hint">{hint}</span> : null}
		</div>
	);
}

interface ConfigEditorProps {
	readonly name: string;
	readonly description: string;
	readonly welcome: string;
	readonly suggestedQuestions: readonly string[];
	readonly welcomeMax: number;
	readonly nameMax: number;
	readonly descMax: number;
	readonly avatarEnabled: boolean;
	readonly welcomeDirty: boolean;
	readonly onWelcomeChange: (next: string) => void;
	readonly onAddQuestion: () => void;
	readonly onRemoveQuestion: (index: number) => void;
	readonly onToggleAvatar: () => void;
}

function ConfigEditor({
	name,
	description,
	welcome,
	suggestedQuestions,
	welcomeMax,
	nameMax,
	descMax,
	avatarEnabled,
	welcomeDirty,
	onWelcomeChange,
	onAddQuestion,
	onRemoveQuestion,
	onToggleAvatar,
}: ConfigEditorProps) {
	return (
		<section className="adp-config">
			<header className="adp-config__head">
				<h2 className="adp-config__title">基本信息</h2>
				{welcomeDirty ? (
					<span className="adp-config__unsaved">
						<span className="adp-config__unsaved-dot" />
						未保存的更改
					</span>
				) : null}
			</header>

			<div className="adp-field">
				<FieldLabel required hint="（后端字段未暴露编辑入口）">
					Agent 名称
				</FieldLabel>
				<div className="adp-input-wrap">
					<input
						className="adp-input"
						type="text"
						defaultValue={name}
						maxLength={50}
						readOnly
						title="Agent 名称在当前 Control API 中为只读字段"
					/>
					<span className="adp-input__count">{`${name.length}/50`}</span>
				</div>
			</div>

			<div className="adp-field">
				<FieldLabel hint="（后端字段未暴露编辑入口）">简介</FieldLabel>
				<div className="adp-input-wrap adp-input-wrap--textarea">
					<textarea
						className="adp-input adp-input--textarea"
						defaultValue={description}
						maxLength={200}
						rows={3}
						readOnly
						title="简介在当前 Control API 中为只读字段"
					/>
					<span className="adp-input__count">{`${description.length}/200`}</span>
				</div>
			</div>

			<div className="adp-field">
				<div className="adp-field__label">
					Agent 形象
					<span className="adp-field__hint">（capabilities.avatar · 上传前端 mock）</span>
				</div>
				<div className="adp-avatar-row">
					<div className={`adp-avatar-existing${avatarEnabled ? "" : " is-off"}`} aria-label="当前形象">
						<Icon name="scale" size={28} />
					</div>
					<button
						type="button"
						className="adp-avatar-upload"
						onClick={onToggleAvatar}
						title="点击仅切换 capabilities.avatar 标志位；图像上传需新增后端能力"
					>
						<span className="adp-avatar-upload__icon">
							<Icon name="upload" size={20} />
						</span>
						<span className="adp-avatar-upload__primary">点击上传</span>
						<span className="adp-avatar-upload__secondary">或拖拽文件到此处</span>
					</button>
				</div>
				<div className="adp-avatar-hint">支持 JPG、PNG 格式，大小不超过 2MB</div>
			</div>

			<div className="adp-field">
				<FieldLabel required hint="（后端字段为 systemPrompt）">
					欢迎语
				</FieldLabel>
				<div className="adp-input-wrap adp-input-wrap--textarea">
					<textarea
						className="adp-input adp-input--textarea adp-input--textarea-lg"
						value={welcome}
						maxLength={500}
						rows={5}
						onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onWelcomeChange(e.target.value)}
					/>
					<span className="adp-input__count">{`${welcome.length}/500`}</span>
				</div>
			</div>

			<div className="adp-field">
				<div className="adp-field__label">
					建议问题
					<span className="adp-field__hint">（前端 mock · 后端无对应字段）</span>
				</div>
				<ul className="adp-suggest">
					{suggestedQuestions.map((q, i) => (
						<li key={i} className="adp-suggest__item">
							<span className="adp-suggest__drag">
								<Icon name="drag" size={14} />
							</span>
							<span className="adp-suggest__text">{q}</span>
							<button
								type="button"
								className="adp-suggest__close"
								aria-label="删除"
								onClick={() => onRemoveQuestion(i)}
							>
								<Icon name="close" size={14} />
							</button>
						</li>
					))}
				</ul>
				<button type="button" className="adp-suggest__add" onClick={onAddQuestion}>
					<span className="adp-suggest__add-icon">
						<Icon name="plus" size={14} />
					</span>
					添加建议问题
				</button>
			</div>
		</section>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Right chat preview
// ────────────────────────────────────────────────────────────────────────────

interface ChatPreviewProps {
	readonly title: string;
}

function ChatPreview({ title }: ChatPreviewProps) {
	return (
		<aside className="adp-chat">
			<header className="adp-chat__head">
				<h2 className="adp-chat__title">Chat 预览</h2>
				<button
					type="button"
					className="adp-iconbtn"
					aria-label="刷新"
					title="刷新会重新拉取 Agent 详情（不刷新聊天记录）"
				>
					<Icon name="refresh" size={16} />
				</button>
			</header>

			<div className="adp-chat__hero">
				<div className="adp-chat__hero-icon">
					<Icon name="scale" size={20} />
				</div>
				<div className="adp-chat__hero-text">
					<div className="adp-chat__hero-name">{title}</div>
					<div className="adp-chat__hero-status">
						<span className="adp-chat__hero-dot" />
						在线
					</div>
				</div>
			</div>

			<div className="adp-chat__body">
				<div className="adp-msg-row adp-msg-row--user">
					<div className="adp-msg-bubble">{MOCK_CHAT.userMessage}</div>
					<div className="adp-msg-avatar">A</div>
				</div>
				<div className="adp-msg-meta adp-msg-meta--user">14:35 ✓</div>

				<div className="adp-thinking">
					<div className="adp-thinking__head">
						<span>思考过程</span>
						<Icon name="chevron-up" size={14} />
					</div>
					<div className="adp-thinking__duration">
						<span className="adp-thinking__dot" />
						已深度思考 {MOCK_CHAT.thinkingDurationSec} 秒
					</div>
					<div className="adp-thinking__body">
						<p className="adp-thinking__intro">{MOCK_CHAT.thinkingBody}</p>
						<ol className="adp-thinking__list">
							{MOCK_CHAT.thinkingItems.map((it, i) => (
								<li key={i} className="adp-thinking__item">
									<div className="adp-thinking__num">
										{i + 1}. {it.title}
									</div>
									<ul className="adp-thinking__sub">
										<li>{it.body}</li>
									</ul>
								</li>
							))}
						</ol>
						<p className="adp-thinking__after">{MOCK_CHAT.afterThinking}</p>
					</div>
				</div>

				<div className="adp-tool">
					<div className="adp-tool__head">
						<span className="adp-tool__name">工具调用：{MOCK_CHAT.toolCall.name}</span>
						<span className="adp-tool__done">
							<Icon name="check" size={12} />
							已完成
						</span>
					</div>
					<div className="adp-tool__row">
						<span className="adp-tool__label">输入文件</span>
						<span className="adp-tool__file">
							<span className="adp-tool__file-icon">
								<Icon name="file" size={12} />
							</span>
							{MOCK_CHAT.toolCall.file.name}
						</span>
						<span className="adp-tool__size">{MOCK_CHAT.toolCall.file.size}</span>
					</div>
					<div className="adp-tool__row adp-tool__row--cats">
						<span className="adp-tool__label">分析维度</span>
						<div className="adp-tool__cats">
							{MOCK_CHAT.toolCall.categories.map((c) => (
								<span key={c} className="adp-tool__cat">
									{c}
								</span>
							))}
						</div>
					</div>
					<div className="adp-tool__row">
						<span className="adp-tool__label">耗时</span>
						<span className="adp-tool__elapsed">{MOCK_CHAT.toolCall.elapsedSec} 秒</span>
					</div>
					<div className="adp-tool__detail">
						<span>查看详细结果</span>
						<Icon name="chevron-right" size={12} />
					</div>
				</div>

				<div className="adp-msg-meta adp-msg-meta--user adp-msg-meta--alone">14:35</div>

				<div className="adp-typing">
					<span className="adp-typing__dot" />
					<span className="adp-typing__dot" />
					<span className="adp-typing__dot" />
					正在生成回复…
				</div>
			</div>

			<div className="adp-composer">
				<div className="adp-composer__box">
					<input type="text" className="adp-composer__input" placeholder="输入消息…" />
					<div className="adp-composer__icons">
						<button type="button" className="adp-composer__icon" aria-label="附件">
							<Icon name="paperclip" size={16} />
						</button>
						<button type="button" className="adp-composer__icon" aria-label="表情">
							<Icon name="emoji" size={16} />
						</button>
					</div>
					<button type="button" className="adp-composer__send" aria-label="发送">
						<Icon name="send" size={16} />
					</button>
				</div>
				<div className="adp-composer__hint">Shift + Enter 换行，Enter 发送</div>
			</div>
		</aside>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Status badge mapping
// ────────────────────────────────────────────────────────────────────────────

function statusBadgeFor(state: AgentState): { label: string; tone: TopHeaderProps["statusBadge"]["tone"] } {
	switch (state.status) {
		case "saved":
			return { label: "已保存", tone: "saved" };
		case "dirty":
			return { label: "未保存", tone: "dirty" };
		case "saving":
			return { label: "保存中…", tone: "saving" };
		case "error":
			return { label: "保存失败", tone: "error" };
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────────────────

/**
 * 独立预览入口（`/ui-preview/agent-design`）：
 * 包一层自己的 `AdminAuthController` + `AdminAuthProvider` + 左侧 NavRail，
 * 让用户能直接打开页面而不用依赖上层 `AppShell`。
 *
 * agentId 走 URL `?agentId=agent_xxx`；未指定时用 preview 占位 id。
 */
export function UiPreviewAgentDesign(): React.ReactElement {
	const controller = useAdminController();
	const agentId = useAgentIdFromUrl();
	return (
		<AdminAuthProvider controller={controller}>
			<div className="adp-root">
				<NavRail />
				<AgentDesignContent agentId={agentId} />
			</div>
		</AdminAuthProvider>
	);
}

/**
 * Phase 2 / Phase 3 真实接入的 Agent 设计白底工作台。
 *
 * 设计为「可在 AppShell 内部直接挂载」的纯右侧内容组件：
 *
 * - 依赖 `useAdminAuth()`：由上层 `AppShell` 内的 `AdminAuthProvider` 提供
 * - 不包含左侧 NavRail —— 上层 shell 已自带
 * - 不创建自己的 `AgentApi` 之外的全局状态
 *
 * 路由层只负责把 `agentId`（来自 `/agents/agent_<uuid>`）传进来；
 * 后端不可达时降级为 mock 并在顶部标 "示例数据"。
 */
export function AgentDesignContent({ agentId }: { agentId: AgentPublicId }): React.ReactElement {
	const { controller } = useAdminAuth();
	const { agent } = useApiClients(controller);

	const [agentState, setAgentState] = useState<AgentState | null>(null);
	const [dataSource, setDataSource] = useState<"live" | "mock">("mock");
	const [loadError, setLoadError] = useState<string | null>(null);

	// Frontend-only local state（后端无对应字段，Phase 1 保留的视觉/示例）
	const [welcome, setWelcome] = useState<string>(MOCK_AGENT.welcome);
	const [welcomeBaseline, setWelcomeBaseline] = useState<string>(MOCK_AGENT.welcome);
	const [questions, setQuestions] = useState<string[]>([...MOCK_AGENT.suggestedQuestions]);
	const [avatarEnabled, setAvatarEnabled] = useState<boolean>(true);

	// Publish drawer
	const [publishMode, setPublishMode] = useState<"closed" | "open">("closed");

	// ── 1. 加载 Agent 详情 ────────────────────────────────────────────────
	useEffect(() => {
		let cancelled = false;
		setAgentState(null);
		setLoadError(null);
		setDataSource("mock");

		// AdminAuthProvider 自动连接时 fetchSession 失败会清掉 controller 的 token；
		// 这里在每次 API 调用前确保 token 在位（dev 占位即可，prod 由网关注入）
		const ensureToken = (): void => {
			if (!controller.getToken()) {
				controller.connect("dev-bypass-placeholder");
			}
		};
		ensureToken();

		agent
			.getAgentDetail(agentId)
			.then((detail) => {
				if (cancelled) return;
				const s = initialAgentState(detail);
				setAgentState(s);
				const initial = s.draft.systemPrompt || MOCK_AGENT.welcome;
				setWelcome(initial);
				setWelcomeBaseline(initial);
				setDataSource("live");
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				const msg = err instanceof Error ? err.message : "Unknown error";
				setLoadError(msg);
				setDataSource("mock");
				const fallback = {
					id: agentId,
					agentId,
					name: MOCK_AGENT.name,
					description: MOCK_AGENT.description,
					currentRevision: 12,
					updatedAt: MOCK_AGENT.revisionAt,
					updatedBy: "Acme Corp",
					modelId: null as string | null,
					systemPrompt: MOCK_AGENT.welcome,
					parameters: {},
					toolIds: [] as string[],
					knowledgeBaseIds: [] as string[],
					capabilities: {
						liveSpeech: false,
						avatar: true,
						attachments: false,
						citations: false,
						realtime: false,
						webSearch: false,
					},
					hasDraft: false,
					changeSummary: null,
					associatedAppCount: 0,
				} as unknown as Parameters<typeof initialAgentState>[0];
				setAgentState(initialAgentState(fallback));
			});

		return () => {
			cancelled = true;
		};
	}, [agent, agentId, controller]);

	// ── 2. Save handler —— 真实 POST /revisions ───────────────────────────
	const handleSave = useCallback(async () => {
		if (!agentState) return;
		if (agentState.status === "saving") return;
		// 重新确保 token（AdminAuthProvider 可能在 auto-connect 失败时清掉过）
		if (!controller.getToken()) controller.connect("dev-bypass-placeholder");
		const advanced = editDraft(agentState, { systemPrompt: welcome });
		if (advanced.status !== "dirty" && advanced.status !== "error") {
			return;
		}
		setAgentState(beginSave(advanced));
		try {
			const idem = newIdempotencyKey({ operation: "agent.save" });
			const resp = await agent.saveRevision(
				advanced.agentId,
				buildSaveRequest(advanced, "Edited via Agent Design preview"),
				idem,
			);
			const nextRevision = "revision" in resp ? Number(resp.revision) : advanced.display.currentRevision + 1;
			setAgentState(saveSucceeded(advanced, advanced.draft, nextRevision));
			setWelcomeBaseline(welcome);
		} catch (err: unknown) {
			const msg = err instanceof AgentApiError ? err.message : err instanceof Error ? err.message : "保存失败";
			setAgentState(saveFailed(advanced, msg));
		}
	}, [agent, agentState, controller, welcome]);

	// ── 3. Publish handler —— 打开真实的 PublishDrawer ────────────────────
	const handlePublish = useCallback(() => {
		if (!agentState) return;
		setPublishMode("open");
	}, [agentState]);

	const handleAddQuestion = useCallback(() => {
		setQuestions((qs) => [...qs, "（点击编辑这条新建议）"]);
	}, []);

	const handleRemoveQuestion = useCallback((index: number) => {
		setQuestions((qs) => qs.filter((_, i) => i !== index));
	}, []);

	const handleToggleAvatar = useCallback(() => {
		setAvatarEnabled((v) => !v);
	}, []);

	// ── 4. Render ────────────────────────────────────────────────────────
	// 注意：这里只渲染右侧白底内容（adp-main），左侧 NavRail 由上层 wrapper 提供。
	// 上层可能是 AppShell（生产 / 真实路由）或 `UiPreviewAgentDesign`（独立预览）。
	if (!agentState) {
		return (
			<div className="adp-main">
				<div className="adp-loading">加载中…</div>
			</div>
		);
	}

	const badge = statusBadgeFor(agentState);
	const welcomeDirty = welcome !== welcomeBaseline;
	const canSave = welcomeDirty && agentState.status !== "saving";
	const canPublish = agentState.status === "saved";

	return (
		<>
			<div className="adp-main">
				<TopHeader
					title={agentState.display.name}
					statusBadge={badge}
					revisionLabel={`r${agentState.display.currentRevision}`}
					revisionAt={agentState.display.updatedAt}
					unsavedNote={null}
					dataSourceBadge={{
						label: dataSource === "live" ? "实时数据" : "示例数据",
						tone: dataSource,
					}}
					saveDisabled={!canSave}
					publishDisabled={!canPublish}
					saveTitle={
						loadError ? `保存可能失败：${loadError}` : welcomeDirty ? "保存欢迎语到后端" : "没有需要保存的更改"
					}
					onSave={handleSave}
					onPublish={handlePublish}
				/>
				{loadError ? (
					<div className="adp-banner" role="status">
						<span className="adp-banner__dot" />
						后端未连接（{loadError}）— 显示 Phase 1 视觉示例数据。修改仍可保存， 保存动作会真实调用{" "}
						<code>POST /api/control/v1/agent-definitions/.../revisions</code>。
					</div>
				) : null}
				<div className="adp-body">
					<SecondaryNav />
					<ConfigEditor
						name={agentState.display.name}
						description={MOCK_AGENT.description}
						welcome={welcome}
						suggestedQuestions={questions}
						welcomeMax={500}
						nameMax={50}
						descMax={200}
						avatarEnabled={avatarEnabled}
						welcomeDirty={welcomeDirty}
						onWelcomeChange={setWelcome}
						onAddQuestion={handleAddQuestion}
						onRemoveQuestion={handleRemoveQuestion}
						onToggleAvatar={handleToggleAvatar}
					/>
					<ChatPreview title={agentState.display.name} />
				</div>
			</div>
			<PublishDrawer
				agentId={agentState.agentId}
				hasDraft={agentState.status !== "saved"}
				mode={publishMode}
				onClose={() => setPublishMode("closed")}
				onPublished={() => {
					setPublishMode("closed");
					if (!controller.getToken()) controller.connect("dev-bypass-placeholder");
					agent
						.getAgentDetail(agentState.agentId)
						.then((d) => setAgentState(initialAgentState(d)))
						.catch(() => {
							/* 后端不可达时静默忽略 */
						});
				}}
			/>
		</>
	);
}

export default UiPreviewAgentDesign;
// keep the linter happy about the imported style
export const __adpStylesLoaded: CSSProperties | undefined = undefined;
// `AgentConfigSnapshot` is used in the agent-state reducer signatures; this re-export
// keeps tree-shakers from dropping the import and keeps the type close to the integration
// site for future maintainers.
export type { AgentConfigSnapshot };
