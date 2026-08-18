# UI RULES — Hard Constraints

Short, strict constraints for implementing Chat / Agent / RAG / Data Analysis pages on top of
`LAYOUT.md`, `COMPONENT_PATTERNS.md`, `MOTION.md`, `INTERACTION.md`.
If a rule and a new idea conflict, the rule wins; propose a spec change first.

## Layout

1. Reuse existing patterns before creating new ones. If a component exists in `docs/ui-patterns/`, use it; do not fork it.
2. Assistant content is a reading canvas, not a chat bubble. No card wrapper around an answer.
3. User messages: right-aligned, max-width 62% of content width, single bubble, body-small type tier.
4. Agent execution is separate from the final answer: canvas (answer) + 250px rail (trace). Never share one container.
5. Structured data may use containers (table / chart / sources / artifact). Prose stays on the canvas.
6. Every container has a caption (title + source/unit) and sits inside the reading column with em bottom margin.
7. Full-width layout is reserved for wide-data artifacts only.
8. Widths come from the layout scale (1240 / 820 / 250 / 62%). No ad-hoc widths.
9. Spacing comes from the 4px scale; prose rhythm uses em units (1.3em / 2em / 0.7em). No arbitrary spacing.
10. Breakpoint 1100px: rail collapses to an inline trace disclosure. Trace must remain reachable, never deleted.

## Typography

11. Use semantic type tokens (`--text-display` … `--text-code`). No per-component hard-coded font-size/line-height.
12. Three tiers: display tier for titles/lede/section headings; sans tier for UI/body; monospace for code/numbers.
13. Numbers and code values: monospace; right-aligned inside tables.
14. Metadata (model, duration, source meta, trace detail) is always label/meta tier, visually subordinate to content.
15. Wide letter-spacing + uppercase is reserved for label-tier section markers.

## Components

16. AssistantSignature is the first element of every response; Actions is the last.
17. At most one Lede per answer. Multi-section answers use numbered headings (01, 02, …).
18. Inline cites are numbered and map 1:1 to the Sources list.
19. DataTable: caption required, numeric columns right-aligned monospace, row dividers only (no vertical borders, no zebra).
20. Chart: fixed plot height, caption with unit, emphasized point via accent (not a new palette), never chart-only without prose.
21. Source item: 2px accent left border, index + title/meta + type badge, hover = border lift + 3px shift.
22. Artifact: header (eyebrow / title / meta / status badge) + TOC body. Body is a section list, never the full content. Actions live outside the artifact.
23. Composer: fixed dock, 820px, textarea auto-grow capped at 150px, exactly one primary button (Send), modes multi-select, model single-select, hint line centered below the box.
24. At most 4 actions per answer, at most 1 key (accent) action. Destructive actions go to a confirm layer.

## Motion

25. Motion must communicate state. No decorative animation.
26. Never animate for decoration only; never animate tokens/characters — the semantic block is the minimum unit.
27. Animate `opacity` / `transform` only.
28. At most one running pulse per viewport (active step only).
29. Actions fade in only after completion (`motion-actions-enter`).
30. Respect `prefers-reduced-motion`: every primitive degrades to a static state; all loops are disabled.
31. Re-render never replays enter animations.

## Content / Agent

32. Never expose chain-of-thought. The trace shows semantic execution events only.
33. One event = one DOM node across its lifecycle (`pending → running → completed | failed`). Tool results update the existing node; they never create a new one.
34. Aggregate protocol events into user-level actions: title = verb + object, detail ≤ 1 line with ≤ 2 metrics.
35. Progressive disclosure: ≤ 5 summary events in the rail; the full trace lives behind the disclosure link.
36. Complex deliverables use an Artifact, not more prose.
37. The last trace event stays `running` until the body stream finishes.

## Theming

38. No color values in page or component code. All color comes from theme tokens: border / bg / text tiers, accent, success, danger, muted.
39. Semantic states (up/down/risk/failed/done) map to theme semantic colors via state classes — never inline colors.
