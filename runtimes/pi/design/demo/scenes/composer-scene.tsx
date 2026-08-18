import { useEffect, useRef, useState } from "react";
import {
	AssistantResponse,
	AssistantSignature,
	Composer,
	Prose,
	UserMessage
} from "../../src";

type Echo = { id: number; text: string };

/**
 * 场景 9（Composer）：页面级 fixed dock 实例 + 键盘行为 + stop 状态模拟。
 * 提交回显是 demo 行为（不绑定业务 API）：追加一条 plain 对话。
 */
export function ComposerScene() {
	const [echoes, setEchoes] = useState<Echo[]>([]);
	const [streaming, setStreaming] = useState(false);
	const nextId = useRef(1);

	useEffect(() => {
		if (!streaming) return;
		const timer = setTimeout(() => setStreaming(false), 4000);
		return () => clearTimeout(timer);
	}, [streaming]);

	const handleSubmit = (text: string) => {
		setEchoes((prev) => [...prev.slice(-2), { id: nextId.current++, text }]);
	};

	return (
		<section className="dm-scene">
			<div className="dm-scene-head">
				<div className="dm-scene-no">09</div>
				<div className="dm-scene-title">Composer（fixed dock）</div>
				<div className="dm-scene-desc">
					⏎ 发送 · ⇧⏎ 换行 · /（空输入）唤起菜单；textarea 自适应 1 行 → 150px；modes 多选；
					生成中 Send → Stop。页面底部固定的 dock 即其实例。
				</div>
			</div>
			<div className="dm-frame">
				<div className="dm-toolbar">
					<button
						type="button"
						className="dm-btn"
						disabled={streaming}
						onClick={() => setStreaming(true)}
					>
						{streaming ? "生成中（观察 Stop 状态）…" : "模拟生成（4s，验证 stop 状态）"}
					</button>
				</div>
				<div className="dm-note" style={{ marginTop: 0, marginBottom: "var(--ai-space-md)" }}>
					键盘：<code>⏎</code> 发送 / <code>⇧⏎</code> 换行 / <code>/</code>（空输入时）唤起附件与工具菜单；
					发送按钮是全视口唯一 primary 控件；提交后文本在此回显（demo，无业务 API）。
				</div>
				{echoes.length > 0 ? (
					<div className="dm-echo">
						{echoes.map((echo) => (
							<div key={echo.id} style={{ display: "grid", gap: "var(--ai-space-sm)" }}>
								<UserMessage variant="plain">{echo.text}</UserMessage>
								<AssistantResponse>
									<AssistantSignature status="plain" name="Nocturne" model="GLM-5" />
									<Prose plain>
										<p>（demo echo：收到「{echo.text.slice(0, 24)}…」）</p>
									</Prose>
								</AssistantResponse>
							</div>
						))}
					</div>
				) : (
					<div className="dm-note">尚未提交：用底部 dock 发送一条消息试试。</div>
				)}
			</div>

			<Composer
				onSubmit={handleSubmit}
				streaming={streaming}
				onStop={() => setStreaming(false)}
				placeholder="问点什么，或把任务交给 Nocturne…"
				modes={[
					{ id: "kb", label: "知识库", active: true },
					{ id: "web", label: "联网", active: false },
					{ id: "deep", label: "深思考", active: true }
				]}
				onModeToggle={(id) => {
					// demo 不持有 modes state（业务层持有）；此处仅演示 API 形状
					console.debug("mode toggle:", id);
				}}
				menuItems={[
					{ label: "📎 上传文件" },
					{ label: "🗂 引用知识库文档" },
					{ label: "🧩 选择 Agent 技能" },
					{ label: "🌐 联网搜索" },
					{ label: "📅 引用日程数据" }
				]}
				model={
					<button type="button" className="ai-composer-model" onClick={() => console.debug("model select")}>
						GLM-5 ▾
					</button>
				}
			/>
		</section>
	);
}
