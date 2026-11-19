import { inspectFeatureModuleGraph, preflightLvglEventGraphForConsumer, loadNumericEnvironment,
  type NumericEnvironment, type NumericEnvironmentOptions } from "../../target/studio/modules/sdk/feature-validator.js";
import { PRESET } from "../../target/studio/modules/preset.ts";
import type { ModuleGraphInput, ModuleState, ModuleTrace } from "./protocol.ts";

export class ModuleRuntime {
  private environment?: NumericEnvironment;
  private count = 0;
  private subscribed = true;
  private nested: number[] = [];
  private readonly trace: ModuleTrace[] = [];

  constructor(private readonly input: ModuleGraphInput, private readonly width: number, private readonly height: number) {}

  private options(): NumericEnvironmentOptions {
    return {
      profile: "lvgl-event-v1",
      lvgl: { module: "lvcore", id: "host.lvw", interface: { name: "lvw", version: 1 }, abiVersion: 1 },
      label: { ...PRESET.label, width: this.width, height: this.height },
      event: PRESET.event,
      modules: PRESET.modules,
      hosts: PRESET.hosts.map((host) => ({
        ...host,
        create: (module: string) => ({
          exports: { lifecycle: (code: number) => { this.trace.push({ module, code }); } },
          close: () => {},
        }),
      })),
      wasi: {
        id: "host.wasi", interface: { name: "wasi", version: 1 },
        allowed: PRESET.wasi,
        outputFds: [], maxIovecs: 16, maxWriteBytes: 4096, maxOutputBytes: 4096,
        clock: { realtimeNs: 0n, monotonicNs: 0n },
        onWrite: () => { throw new Error("The module preset does not allow WASI output"); },
      },
      ...PRESET.limits,
      allowedFeatures: PRESET.allowedFeatures,
      startupTimeoutMs: 10_000,
      executionTimeoutMs: 10_000,
    };
  }

  async inspect() {
    const options = this.options();
    const report = await inspectFeatureModuleGraph(this.input, options);
    const executable = this.input.modules.length === PRESET.modules.length
      && PRESET.modules.every((contract) => this.input.modules.some(({ manifest }) =>
        manifest.id === contract.id && manifest.artifact.sha256 === contract.sha256));
    if (executable) await preflightLvglEventGraphForConsumer(this.input, options);
    return { report, executable };
  }

  async start(): Promise<void> {
    if (this.environment) throw new Error("The module environment has already started");
    this.environment = await loadNumericEnvironment(this.input, this.options());
    this.count = this.environment.run(0);
  }

  snapshot(): ModuleState {
    if (!this.environment || !["ready", "closed", "poisoned"].includes(this.environment.state)) {
      throw new Error("The module environment has no runtime state");
    }
    return { state: this.environment?.state === "poisoned" ? "poisoned"
      : this.environment?.state === "closed" ? "closed" : "ready",
    count: this.count, subscribed: this.subscribed, nested: [...this.nested], trace: this.trace.map((item) => ({ ...item })) };
  }

  action(action: "event" | "subscribe" | "unsubscribe"): ModuleState {
    if (!this.environment) throw new Error("The module environment has not started");
    if (action === "event") {
      this.count = this.environment.run(1);
      this.nested = [5, 6, 7, 8].map((value) => this.environment!.run(value));
    } else if (action === "subscribe") {
      if (!this.subscribed && this.environment.run(3) !== 1) throw new Error("C event registration failed");
      this.subscribed = true;
    } else if (action === "unsubscribe") {
      if (this.subscribed && this.environment.run(2) !== 1) throw new Error("C event removal failed");
      this.subscribed = false;
    } else {
      throw new Error("Unknown module action");
    }
    return this.snapshot();
  }

  frame() {
    if (!this.environment?.readFrame) throw new Error("The module environment has no frame");
    return this.environment.readFrame();
  }

  close(): ModuleState {
    if (!this.environment) throw new Error("The module environment has not started");
    this.environment.close();
    this.subscribed = false;
    return this.snapshot();
  }
}
