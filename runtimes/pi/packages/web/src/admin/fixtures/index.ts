/**
 * M1: 控制台 fixture 适配层公开入口。
 *
 * 调用方只 import 自此文件；内部 `adapter.ts` 与未来增补的 fixture 表
 * 不直接暴露给组件。
 */
export {
	type DataState,
	describeError,
	type FixtureEntry,
	type FixtureName,
	loadFixture,
} from "./adapter.ts";
