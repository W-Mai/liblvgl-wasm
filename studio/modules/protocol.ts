import type { loadNumericEnvironment, FeatureModuleGraphReport, NumericEnvironmentOptions } from "../../target/studio/modules/sdk/feature-validator.js";

export type ModuleGraphInput = Parameters<typeof loadNumericEnvironment>[0];

export interface ModuleRun {
  mode: "modules";
  operation: "inspect" | "run";
  sample: boolean;
  input: ModuleGraphInput;
  width: number;
  height: number;
}

export interface ModuleTrace {
  module: string;
  code: number;
}

export interface ModuleState {
  state: "ready" | "closed" | "poisoned";
  count: number;
  result: number | null;
  subscribed: boolean;
  nested: number[];
  trace: ModuleTrace[];
}

export type ModuleAction = "event" | "subscribe" | "unsubscribe" | "invoke";
export type ModuleCommand =
  | { type: "module-action"; id: number; action: ModuleAction; value?: number }
  | { type: "module-close" };

export type ModuleOutput =
  | { type: "module-inspected"; report: FeatureModuleGraphReport; executable: boolean; profile: NumericEnvironmentOptions["profile"] | null; reason?: string }
  | { type: "module-ready"; width: number; height: number; snapshot: ModuleState }
  | { type: "module-state"; id: number; snapshot: ModuleState }
  | { type: "module-closed"; snapshot: ModuleState };

export type ModuleWorkerOutput = ModuleOutput
  | { type: "frame"; width: number; height: number; frameId: number; pixels: ArrayBuffer }
  | { type: "error"; message: string; detail: {
    code: "library-load" | "runtime"; phase: "load" | "runtime"; message: string;
  } };
