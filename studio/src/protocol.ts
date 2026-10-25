import type { CoreReport } from "./core.ts";

export type AppSource = { kind: "js"; source: string } | { kind: "wasm"; bytes: ArrayBuffer };

export interface ResourceSource {
  name: string;
  bytes: ArrayBuffer;
}

export interface FirmwareRun {
  mode: "firmware";
  firmware: ArrayBuffer;
  width: number;
  height: number;
}

export interface LvglAppRun {
  mode: "lvgl-app";
  core: ArrayBuffer;
  app: AppSource;
  resources: ResourceSource[];
  width: number;
  height: number;
}

export type RunnerInput =
  | ({ type: "start" } & (FirmwareRun | LvglAppRun))
  | { type: "pointer"; x: number; y: number; pressed: boolean }
  | { type: "resize"; width: number; height: number }
  | { type: "stop" };

export interface FirmwareRuntimeReport {
  abi: number;
  sha256: string;
}

export type RunnerOutput =
  | { type: "ready"; mode: "lvgl-app"; width: number; height: number; core: CoreReport }
  | { type: "ready"; mode: "firmware"; width: number; height: number; firmware: FirmwareRuntimeReport }
  | { type: "frame"; width: number; height: number; frameId: number; pixels: ArrayBuffer }
  | { type: "log"; message: string }
  | { type: "error"; message: string };
