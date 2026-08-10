import * as RiveCanvasModule from "@rive-app/canvas";
import type {
  Event as RiveEvent,
  RiveParameters,
  StateMachineInputType as RiveInputType,
} from "@rive-app/canvas";

type RiveCanvasApi = Pick<typeof RiveCanvasModule, "Rive" | "StateMachineInputType">;

// @rive-app/canvas is exposed as named ESM exports by browser bundlers and as
// a CommonJS-shaped default object by Node. Normalize both without leaking the
// compatibility detail into the renderer.
const riveCanvasApi =
  ((RiveCanvasModule as unknown as { default?: RiveCanvasApi }).default ??
    RiveCanvasModule) as RiveCanvasApi;

export const StateMachineInputType = riveCanvasApi.StateMachineInputType;

export interface RiveInputLike {
  readonly name: string;
  readonly type: RiveInputType;
  value: number | boolean;
  fire(): void;
}

export interface RiveInstanceLike {
  stateMachineInputs(name: string): RiveInputLike[];
  resizeDrawingSurfaceToCanvas(devicePixelRatio?: number): void;
  cleanup(): void;
}

export interface RiveInstanceParameters {
  canvas: HTMLCanvasElement;
  src: string;
  stateMachines: string;
  autoplay: boolean;
  shouldDisableRiveListeners: boolean;
  automaticallyHandleEvents: boolean;
  onLoad(event: RiveEvent): void;
  onLoadError(event: RiveEvent): void;
}

export interface RiveRendererDependencies {
  createCanvas(): HTMLCanvasElement;
  createInstance(parameters: RiveInstanceParameters): RiveInstanceLike;
}

export const defaultRiveRendererDependencies: RiveRendererDependencies = {
  createCanvas: () => document.createElement("canvas"),
  createInstance: (parameters) =>
    new riveCanvasApi.Rive(parameters satisfies RiveParameters),
};
