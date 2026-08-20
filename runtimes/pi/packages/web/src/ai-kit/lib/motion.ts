import { useEffect, useRef, useState } from "react";

/**
 * prefers-reduced-motion（SSR 安全）。
 * 所有 JS 驱动的 motion（count-up、data-enter）必须经由此 hook 退化。
 * 见 docs/ui-patterns/MOTION.md §4。
 */
export function usePrefersReducedMotion(): boolean {
	const [reduced, setReduced] = useState(() => {
		if (typeof window === "undefined" || !window.matchMedia) return false;
		return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	});

	useEffect(() => {
		if (typeof window === "undefined" || !window.matchMedia) return;
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		const onChange = () => setReduced(query.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);

	return reduced;
}

/**
 * motion-data-enter（计数变体）：0 → target，durationMs 默认 1000，ease-out。
 * reduced-motion 时直接返回终值。
 */
export function useCountUp(target: number, durationMs = 1000): number {
	const reduced = usePrefersReducedMotion();
	const [value, setValue] = useState(reduced ? target : 0);
	const frameRef = useRef<number>(0);

	useEffect(() => {
		if (reduced) {
			setValue(target);
			return;
		}
		const start = performance.now();
		const tick = (now: number) => {
			const t = Math.min(1, (now - start) / durationMs);
			const eased = 1 - (1 - t) ** 3;
			setValue(Math.round(target * eased));
			if (t < 1) frameRef.current = requestAnimationFrame(tick);
		};
		frameRef.current = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frameRef.current);
	}, [target, durationMs, reduced]);

	return value;
}
