/**
 * `@rive-app/canvas` 本地类型桩（M1 R1）。
 *
 * `packages/avatar/src/renderers/rive/runtime.ts` import 了
 * `@rive-app/canvas` 的运行时 API（`Rive`、`StateMachineInputType`）和
 * 类型（`Event`、`RiveParameters`）。该包是 `@skdy/avatar` 的运行依赖，
 * 未在 pi monorepo 顶层 `npm install` 中安装（avatar 包独立 node_modules，
 * 与 pi workspaces 不互通）。
 *
 * web 的 typecheck 通过 path alias `"@skdy/avatar": ["../../../../packages/avatar/src/index.ts"]`
 * 顺路拉到了 `runtime.ts`，因此 TS2307 也波及 web。
 *
 * 本桩只为 typecheck 提供最小形状；**不影响运行时**——web 实际运行根本不
 * 经过 rive 渲染器（运行时由 avatar 包自己通过动态 import + jsdom 加载）。
 * 类型最小集覆盖 `runtime.ts` 实际 import 的符号：
 *   - `Rive` 类：构造接受 `RiveInstanceParameters`，并暴露
 *     `stateMachineInputs / resizeDrawingSurfaceToCanvas / cleanup`；
 *   - `StateMachineInputType`：enum；
 *   - `RiveParameters`：与 `RiveInstanceParameters` 同义；
 *   - `Event`：通用事件类型。
 *
 * 一旦 `@rive-app/canvas` 真正进入 web 的 node_modules，可直接删除本文件
 * 与 tsconfig 的 `paths` 映射，恢复默认 node_modules 解析。
 */
declare module "@rive-app/canvas" {
	export enum StateMachineInputType {
		Boolean = 0,
		Number = 1,
		Trigger = 2,
	}
	export type Event = {
		readonly type: string;
		readonly name: string;
		[k: string]: unknown;
	};
	export interface RiveInstanceParameters {
		canvas: HTMLCanvasElement;
		src: string;
		stateMachines: string;
		autoplay: boolean;
		shouldDisableRiveListeners: boolean;
		automaticallyHandleEvents: boolean;
		onLoad(event: Event): void;
		onLoadError(event: Event): void;
	}
	export type RiveParameters = RiveInstanceParameters;
	export class Rive {
		constructor(options: RiveInstanceParameters);
		stateMachineInputs(name: string): Array<{
			readonly name: string;
			readonly type: StateMachineInputType;
			value: number | boolean;
			fire(): void;
		}>;
		resizeDrawingSurfaceToCanvas(devicePixelRatio?: number): void;
		cleanup(): void;
		[k: string]: unknown;
	}
}