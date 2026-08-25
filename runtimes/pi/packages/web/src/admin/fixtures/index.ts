/**
 * M1: 控制台 fixture 适配层公开入口（开发期）。
 *
 * 生产代码**禁止**从本入口 import；生产模块只 import `../data-state.ts`。
 * 本入口仅供单元测试、Storybook 或明确标记的开发入口（如 dev 控制台 mock 注入）使用。
 *
 * 隔离机制：`loadFixture` 唯一放行条件是调用方显式置
 * `globalThis.__PI_WEB_FIXTURES_ALLOWED__ = true`；生产代码永远不会置
 * 这个标志（参见 `adapter.ts`）。
 */

export type { FixtureEntry, FixtureName } from "./adapter.ts";
export { loadFixture } from "./adapter.ts";
