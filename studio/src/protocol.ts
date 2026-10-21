import type { CoreReport } from "./core.ts";

export type AppSource = { kind: "js"; source: string } | { kind: "wasm"; bytes: ArrayBuffer };

export interface ResourceSource {
  name: string;
  bytes: ArrayBuffer;
}

export type RunnerInput =
  | { type: "start"; core: ArrayBuffer; app: AppSource; resources: ResourceSource[]; width: number; height: number }
  | { type: "pointer"; x: number; y: number; pressed: boolean }
  | { type: "resize"; width: number; height: number }
  | { type: "stop" };

export type RunnerOutput =
  | { type: "ready"; width: number; height: number; core: CoreReport }
  | { type: "frame"; width: number; height: number; frameId: number; pixels: ArrayBuffer }
  | { type: "log"; message: string }
  | { type: "error"; message: string };
