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
  /** Existing uploaded JS applications keep native API access unless explicitly disabled. */
  allowNativeApi?: boolean;
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

export type RunnerErrorCode =
  | "library-load"
  | "application-syntax"
  | "application-start"
  | "application-async"
  | "runtime"
  | "unsupported";

export interface RunnerError {
  code: RunnerErrorCode;
  phase: "load" | "compile" | "start" | "runtime";
  message: string;
  line?: number;
  column?: number;
}

export type RunnerOutput =
  | { type: "ready"; mode: "lvgl-app"; width: number; height: number; core: CoreReport }
  | { type: "ready"; mode: "firmware"; width: number; height: number; firmware: FirmwareRuntimeReport }
  | { type: "frame"; width: number; height: number; frameId: number; pixels: ArrayBuffer }
  | { type: "log"; message: string }
  | { type: "error"; message: string; detail: RunnerError };
