/**
 * 流式光标：挂在最后一个 streaming block 末尾，流结束即移除。
 * blink 节奏由 motion.css 决定；reduced-motion 下隐藏。
 */
export function StreamCursor() {
	return <span aria-hidden className="ai-cursor" />;
}
