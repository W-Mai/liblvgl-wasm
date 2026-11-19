import { inspectFeatureModuleGraph, preflightNumericEnvironment, loadNumericEnvironment,
  type NumericEnvironment, type NumericEnvironmentOptions } from "../../target/studio/modules/sdk/feature-validator.js";
import { FEATURE_POLICY, studioProfile } from "./profile.ts";
import type { ModuleAction, ModuleGraphInput, ModuleState, ModuleTrace } from "./protocol.ts";

export class ModuleRuntime {
  private environment?: NumericEnvironment;
  private count = 0;
  private subscribed = false;
  private result: number | null = null;
  private nested: number[] = [];
  private readonly trace: ModuleTrace[] = [];

  constructor(private readonly input: ModuleGraphInput, private readonly width: number, private readonly height: number, private readonly sample: boolean) {}

  private options(): NumericEnvironmentOptions {
    return studioProfile(this.input, this.width, this.height, (item) => {
      if (this.trace.length >= 256) throw new Error("Module lifecycle trace limit exceeded");
      this.trace.push(item);
    });
  }

  async inspect() {
    let profile: NumericEnvironmentOptions["profile"] | null = null;
    try {
      const options = this.options();
      profile = options.profile;
      return { report: await preflightNumericEnvironment(this.input, options), profile, executable: true };
    } catch (error) {
      // A valid graph can still be inspected when Studio lacks a requested host contract.
      const report = await inspectFeatureModuleGraph(this.input, FEATURE_POLICY);
      return { report, profile, executable: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async start(): Promise<void> {
    if (this.environment) throw new Error("The module environment has already started");
    this.environment = await loadNumericEnvironment(this.input, this.options());
    if (this.sample) {
      this.count = this.environment.run(0);
      this.subscribed = true;
    }
  }

  snapshot(): ModuleState {
    if (!this.environment || !["ready", "closed", "poisoned"].includes(this.environment.state)) {
      throw new Error("The module environment has no runtime state");
    }
    return { state: this.environment?.state === "poisoned" ? "poisoned"
      : this.environment?.state === "closed" ? "closed" : "ready",
    result: this.result, count: this.count, subscribed: this.subscribed, nested: [...this.nested], trace: this.trace.map((item) => ({ ...item })) };
  }

  action(action: ModuleAction, value?: number): ModuleState {
    if (!this.environment) throw new Error("The module environment has not started");
    if (action === "invoke") {
      if (value === undefined || !Number.isInteger(value) || (value | 0) !== value) throw new Error("app_run requires a signed i32");
      this.result = this.environment.run(value);
    } else if (!this.sample) {
      throw new Error("Event controls require the built-in C sample");
    } else if (action === "event") {
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
    return this.environment?.readFrame?.();
  }

  close(): ModuleState {
    if (!this.environment) throw new Error("The module environment has not started");
    this.environment.close();
    this.subscribed = false;
    return this.snapshot();
  }
}
