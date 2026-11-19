import { StudioController } from "../src/controller.ts";
import { assetUrl } from "../src/paths.ts";
import type { RunnerOutput } from "../src/protocol.ts";
import type { ModuleAction, ModuleGraphInput, ModuleRun, ModuleState } from "./protocol.ts";

const samples = new WeakSet<ModuleGraphInput>();

export interface ModuleProject {
  schema_version: 1;
  kind: "studio-module-project";
  modules: { manifest: ModuleGraphInput["modules"][number]["manifest"]; source?: string }[];
  hosts: ModuleGraphInput["hosts"];
  files: Record<string, string>;
}

export async function loadModuleProject(): Promise<{ project: ModuleProject; input: ModuleGraphInput }> {
  const base = assetUrl("/target/studio/modules/");
  const response = await fetch(new URL("project.json", base), { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to load the module project");
  const project = await response.json() as ModuleProject;
  if (project.schema_version !== 1 || project.kind !== "studio-module-project"
      || !Array.isArray(project.modules) || project.modules.length !== 3) throw new Error("Invalid built-in module project");
  const modules = await Promise.all(project.modules.map(async ({ manifest }) => {
    if (!/^[a-z][a-z0-9-]*[.]wasm$/.test(manifest.artifact.path)) throw new Error("Invalid built-in module path");
    const file = await fetch(new URL(manifest.artifact.path, base), { cache: "no-store" });
    if (!file.ok) throw new Error("Unable to load " + manifest.artifact.path);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > 32 * 1024 * 1024) throw new Error("Module input exceeds the upload limit");
    return { manifest, bytes };
  }));
  const input = { modules, hosts: project.hosts };
  samples.add(input);
  return { project, input };
}

export class ModuleController {
  private readonly transport: StudioController;
  private ready = false;
  private pending?: { id: number; resolve(value: ModuleState): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
  private closing?: { resolve(value: ModuleState): void; reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>; promise: Promise<ModuleState> };
  private nextId = 1;
  private revision = 0;

  constructor(private readonly onOutput: (output: RunnerOutput) => void) {
    this.transport = new StudioController((output) => {
      if (output.type === "module-ready") this.ready = true;
      if (output.type === "module-state" && this.pending?.id === output.id) {
        clearTimeout(this.pending.timer);
        this.pending.resolve(output.snapshot);
        this.pending = undefined;
      } else if (output.type === "module-closed" && this.closing) {
        clearTimeout(this.closing.timer);
        this.closing.resolve(output.snapshot);
        this.ready = false;
      } else if (output.type === "error") {
        this.ready = false;
        this.cancel(new Error(output.message));
        this.transport.stop();
      }
      this.onOutput(output);
    }, "/target/studio/modules/worker.js");
  }

  async start(input: ModuleGraphInput, width: number, height: number, operation: ModuleRun["operation"] = "run"): Promise<void> {
    const revision = ++this.revision;
    await this.closeEnvironment();
    if (revision !== this.revision) throw new DOMException("Module run cancelled", "AbortError");
    await this.transport.start({ mode: "modules", input, width, height, operation, sample: samples.has(input) });
    if (revision !== this.revision) throw new DOMException("Module run cancelled", "AbortError");
  }

  action(action: ModuleAction, value?: number): Promise<ModuleState> {
    if (!this.ready || this.pending || this.closing || !Number.isSafeInteger(this.nextId)) return Promise.reject(new Error("The module environment is not ready"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.stop(); }, 5000);
      this.pending = { id, resolve, reject, timer };
      this.transport.send({ type: "module-action", id, action, value });
    });
  }

  close(): Promise<ModuleState | undefined> {
    this.revision++;
    return this.closeEnvironment();
  }

  private closeEnvironment(): Promise<ModuleState | undefined> {
    if (this.closing) return this.closing.promise;
    if (!this.ready) {
      this.cancel(new Error("Module operation cancelled"));
      this.transport.stop();
      return Promise.resolve(undefined);
    }
    this.ready = false;
    let resolve!: (value: ModuleState) => void;
    let reject!: (error: Error) => void;
    const response = new Promise<ModuleState>((accept, fail) => { resolve = accept; reject = fail; });
    const request = { resolve, reject, timer: setTimeout(() => { this.stop(); }, 1500), promise: response };
    request.promise = response.finally(() => {
      if (this.closing === request) this.closing = undefined;
      this.transport.stop();
    });
    this.closing = request;
    this.transport.send({ type: "module-close" });
    return request.promise;
  }

  private cancel(error: Error): void {
    for (const request of [this.pending, this.closing]) {
      if (request) { clearTimeout(request.timer); request.reject(error); }
    }
    this.pending = undefined;
    this.closing = undefined;
  }

  stop(): void {
    this.revision++;
    this.ready = false;
    this.cancel(new Error("Module operation cancelled"));
    this.transport.stop();
  }
}
