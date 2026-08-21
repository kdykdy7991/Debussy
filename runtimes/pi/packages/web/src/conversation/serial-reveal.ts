/**
 * 串行显影（serial softReveal）调度。
 *
 * Streamdown 的 animate 插件按 markdown block 独立排布字符级 stagger：每次 rehype
 * 运行的新字符 delay 都从 0 重新计数，跨 block / 跨 text part 互不知晓。于是当多段
 * 内容在同一次渲染中一起出现（重连/切会话后整条流式回复挂载、首个 delta 就包含多个
 * 段落、段落边界处新段与上一段尾部同时显影、工具调用切分出的多个 text part 同时挂载）
 * 时，各段的淡入时间线全部从 t=0 并行开始——即「多段并行」。
 *
 * 本模块按 text 计算一份 SerialRevealPlan：为每个 block 计算串行起始偏移 offset，
 * 让后一段的淡入排在前一段显影结束（含其上次提交仍在运行的尾部动画）之后；多个
 * text part 之间通过共享 RevealClock（wall-clock）串联。AiMessageFlow 在
 * StableMarkdownBlock 的 layout effect 里把 offset 叠加到新 span 的 --sd-delay 上，
 * 已显影的旧 span（duration 0）不受影响。
 */
import { parseMarkdownIntoBlocks } from "streamdown";

/** 与 Streamdown animated 选项中的 stagger / duration 保持同源。 */
export interface RevealTiming {
	stagger: number;
	duration: number;
}

/**
 * 同一条 assistant 消息内所有 text part 共享的显影时钟。
 * freeAt：此前已渲染内容的显影全部结束的 wall-clock 时间点（Date.now() 基准）。
 */
export interface RevealClock {
	freeAt: number;
}

export interface SerialRevealPlan {
	/** 本 plan 对应的 text（用于检测 text 变化、避免重复计算）。 */
	text: string;
	/** parseMarkdownIntoBlocks(text)，与 Streamdown 的 block 划分一致。 */
	blocks: string[];
	/** 每个新增/变化 block 的串行起始偏移（ms，相对本次提交）。未变化的 block 恒为 0。 */
	offsets: number[];
	/** 每个 block 显影结束时间（ms，相对本次提交；供下次提交结算 still-running 尾部）。 */
	ends: number[];
	/** 本 plan 计算时的 Date.now()。 */
	commitAt: number;
	/**
	 * 是否为该 text part 的首次提交（挂载）。挂载时 StableMarkdownBlock 会强制各
	 * block 从 0 开始完整显影（见 animatePlugin 包装），消除插件把上一个 block 的
	 * 字符数漏给下一个 block（标题等无分隔块场景）造成的「部分字符直接弹出」。
	 */
	mount: boolean;
}

/**
 * 估算一个 markdown 片段经 Streamdown animate 插件（sep:"char"）后产生的动画 span 数。
 * 插件把每个非空白字符各自包成 span（空白只推进计数不产生 span），且跳过
 * code/pre/svg/math 祖先下的文本；据此把源码中不参与动画的构造剔除后按非空白字符计数。
 * 中文正文下与实际值一致；带少量行内语法时轻微高估（只会让段间留白稍大，方向安全）。
 */
export function estimateAnimatedSegments(markdown: string): number {
	// fenced code / mermaid / 数学块整体被插件跳过；顶层 4 空格缩进块是缩进代码。
	if (/^[ \t]{0,3}(?:```|~~~)/.test(markdown)) return 0;
	if (/^[ \t]{4}\S/.test(markdown)) return 0;
	const plain = markdown
		.replace(/`{1,3}[^`]*?`{1,3}/g, " ") // 行内代码：插件跳过
		.replace(/\$\$[\s\S]*?\$\$/g, " ") // 数学块
		.replace(/\$[^$\n]+\$/g, " ") // 行内数学
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // 图片：无文本子节点
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // 链接：只保留文字
		.replace(/<[^>\s][^>]*>/g, " ") // html 标签（skipHtml）
		.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, " ") // 标题标记
		.replace(/^[ \t]{0,3}>+[ \t]?/gm, " ") // 引用标记
		.replace(/^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+/gm, "$1") // 列表标记
		.replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gm, " ") // 分隔线
		.replace(/\|/g, " ") // 表格竖线（分隔行同理）
		.replace(/^[ \t:|-]+$/gm, " ") // 表格分隔行
		.replace(/[*_~]{1,3}/g, ""); // 强调标记
	return (plain.match(/\S/g) ?? []).length;
}

/**
 * 计算一次提交的串行显影计划。
 *
 * - 同一次提交内：变化的 block 依次排队（gate），前一段显影结束才轮到下一段；
 * - 跨提交（流式段落边界）：上一段仍在运行的尾部动画（carried）继续作为后续新段的门槛；
 *   block 自身的 carried 不延迟自身新增内容（同段内保持 rolling wave 流式观感）；
 * - 跨 text part：本 part 首次出现时须等 clock.freeAt（其他 part 已排内容的显影终点）。
 *   同一 part 后续增长不再读 clock，段内保持流式 rolling wave。
 *
 * 会以副作用更新 clock.freeAt（在 MarkdownText 渲染期调用，按 text 变化守卫幂等）。
 */
export function computeSerialRevealPlan(
	text: string,
	prev: SerialRevealPlan | undefined,
	clock: RevealClock,
	timing: RevealTiming,
	now: number = Date.now(),
): SerialRevealPlan {
	const blocks = parseMarkdownIntoBlocks(text);
	const elapsed = prev === undefined ? Number.POSITIVE_INFINITY : Math.max(0, now - prev.commitAt);
	const start = prev === undefined ? Math.max(0, clock.freeAt - now) : 0;
	const offsets: number[] = [];
	const ends: number[] = [];
	let gate = start;
	for (let i = 0; i < blocks.length; i++) {
		const block = blocks[i];
		const prevBlock = prev?.blocks[i];
		// 上次提交后仍在运行的尾部动画（相对本次提交的剩余毫秒）。
		const carried = prev === undefined ? 0 : Math.max(0, (prev.ends[i] ?? 0) - elapsed);
		if (prevBlock === block) {
			// 未变化：无新内容，不产生 offset；但未结束的尾部仍要拦住后面的新段。
			offsets[i] = 0;
			ends[i] = carried;
			gate = Math.max(gate, carried);
			continue;
		}
		const suffix = prevBlock === undefined ? block : block.slice(commonPrefixLength(prevBlock, block));
		const segments = estimateAnimatedSegments(suffix);
		offsets[i] = gate;
		if (segments > 0) {
			const cascadeEnd = gate + (segments - 1) * timing.stagger + timing.duration;
			ends[i] = Math.max(cascadeEnd, carried);
			gate = ends[i];
		} else {
			// 分隔块 / 代码块等：没有新 span，不推进排队时间。
			ends[i] = carried;
			gate = Math.max(gate, carried);
		}
	}
	const lastEnd = ends.reduce((max, end) => Math.max(max, end), 0);
	clock.freeAt = Math.max(clock.freeAt, now + lastEnd);
	return { text, blocks, offsets, ends, commitAt: now, mount: prev === undefined };
}

function commonPrefixLength(a: string, b: string): number {
	const limit = Math.min(a.length, b.length);
	let i = 0;
	while (i < limit && a[i] === b[i]) i++;
	return i;
}
