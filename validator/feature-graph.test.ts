import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, test as bunTest } from "bun:test";
import { inspectFeatureModuleGraph as inspectGraph } from "../target/validator/feature-validator.js";

type Operation = { controller: AbortController; promise: ReturnType<typeof inspectGraph> };
type Context = { ending: boolean; active: Set<Operation>; worker?: typeof Worker };
const contexts = new AsyncLocalStorage<Context>();
let current: Context;
const test = (name: string, body: () => void | Promise<void>) => bunTest(name, () => {
  const context: Context = { ending: false, active: new Set() };
  current = context;
  const completion = contexts.run(context, () => Promise.resolve().then(body));
  return completion.catch((error: unknown) => { if (!context.ending) throw error; });
}, 300_000);

function inspectFeatureModuleGraph(input: Parameters<typeof inspectGraph>[0], options: Parameters<typeof inspectGraph>[1]) {
  const context = contexts.getStore()!;
  if (context.ending) return Promise.reject(new Error("test cleanup in progress"));
  const controller = new AbortController();
  const signal = options.signal;
  const forwardAbort = () => controller.abort();
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  const promise = inspectGraph(input, { ...options, signal: controller.signal });
  const operation = { controller, promise };
  context.active.add(operation);
  const release = () => { signal?.removeEventListener("abort", forwardAbort); context.active.delete(operation); };
  promise.then(release, release);
  return promise;
}

afterEach(async () => {
  const context = current;
  context.ending = true;
  const pending = [...context.active];
  for (const operation of pending) operation.controller.abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.allSettled(pending.map(({ promise }) => promise)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("graph test cleanup timed out")), 10_000);
    })]);
  } finally {
    clearTimeout(timer);
    if (current === context && context.worker) Object.defineProperty(globalThis, "Worker", { value: context.worker, configurable: true, writable: true });
  }
}, 30_000);

function useWorker(worker: typeof Worker): void {
  const context = contexts.getStore()!;
  if (context.ending) throw new Error("test cleanup in progress");
  context.worker = globalThis.Worker;
  Object.defineProperty(globalThis, "Worker", { value: worker, configurable: true, writable: true });
}

const leb = (value: number): number[] => {
  const out: number[] = [];
  do { const byte = value % 128; value = Math.floor(value / 128); out.push(byte | (value ? 128 : 0)); } while (value);
  return out;
};
const text = (value: string): number[] => { const bytes = [...new TextEncoder().encode(value)]; return [...leb(bytes.length), ...bytes]; };
const vec = (...entries: number[][]): number[] => [...leb(entries.length), ...entries.flat()];
const section = (id: number, payload: number[]): number[] => [id, ...leb(payload.length), ...payload];
const wasm = (...sections: number[][]): Uint8Array => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, ...sections.flat()]);
const imported = (module: string, name: string, kind: number, ...type: number[]) => [...text(module), ...text(name), kind, ...type];
const exported = (name: string, kind: number, index: number) => [...text(name), kind, ...leb(index)];
const body = (...instructions: number[]) => { const bytes = [0, ...instructions, 11]; return [...leb(bytes.length), ...bytes]; };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fn = { kind: "function", params: [], results: ["i32"] };
const memory = { kind: "memory", minimumPages: 1, maximumPages: 4, shared: false };
const wasi = { kind: "function", params: ["i32", "i32", "i32", "i32"], results: ["i32"] };
const exportedType = (name: string, type: object) => ({ name, ...type });
const required = (module: string, name: string, provider_export: string, type: object) => ({ module, name, provider_export, ...type });

function manifest(id: string, role: "lib" | "app", bytes: Uint8Array, requires: object[], exports: object[]) {
  return { schema_version: 1, kind: "wasm-module", id, role, artifact: { path: `${id}.wasm`, sha256: hash(bytes) },
    target: { abi: "wasip1", features: [] as string[] }, interface: { name: id, version: 1 }, memory_model: "isolated",
    requires, exports, runtime_verification: "not-run" };
}

function fixture(): any {
  const types = section(1, vec([0x60, 0, 1, 0x7f], [0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f]));
  const core = wasm(types, section(2, vec(imported("wasi_snapshot_preview1", "fd_write", 0, 1))),
    section(3, vec([0])), section(5, vec([1, 1, 4])), section(7, vec(exported("get", 0, 1), exported("memory", 2, 0))),
    section(10, vec(body(0x41, 42))));
  const lib = wasm(types, section(2, vec(imported("core", "get", 0, 0))), section(3, vec([0])),
    section(5, vec([1, 1, 4])), section(7, vec(exported("get", 0, 1), exported("memory", 2, 0))),
    section(10, vec(body(0x10, 0, 0x41, 1, 0x6a))));
  const app = wasm(types, section(2, vec(imported("core", "get", 0, 0), imported("lib", "get", 0, 0))),
    section(3, vec([0])), section(5, vec([1, 1, 4])), section(7, vec(exported("run", 0, 2), exported("memory", 2, 0))),
    section(10, vec(body(0x10, 0, 0x10, 1, 0x6a))));
  const getCore = { provider: "core", interface: "core", version: 1, imports: [required("core", "get", "get", fn)] };
  return {
    modules: [
      { manifest: manifest("app", "app", app, [getCore, { provider: "lib", interface: "lib", version: 1, imports: [required("lib", "get", "get", fn)] }], [exportedType("run", fn), exportedType("memory", memory)]), bytes: app },
      { manifest: manifest("lib", "lib", lib, [getCore], [exportedType("get", fn), exportedType("memory", memory)]), bytes: lib },
      { manifest: manifest("core", "lib", core, [{ provider: "host.wasi", interface: "wasi", version: 1,
        imports: [required("wasi_snapshot_preview1", "fd_write", "fd_write", wasi)] }], [exportedType("get", fn), exportedType("memory", memory)]), bytes: core },
    ],
    hosts: [{ id: "host.wasi", interface: { name: "wasi", version: 1 }, exports: [exportedType("fd_write", wasi)] }],
  };
}

const options = { allowedFeatures: [] as string[], startupTimeoutMs: 30_000, executionTimeoutMs: 30_000 };
const byId = (input: any, id: string) => input.modules.find((item: any) => item.manifest.id === id);

test("one snapshot connects graph identity, feature, WASI and isolated facts", async () => {
  const input = fixture();
  const report = await inspectFeatureModuleGraph(input, options);
  expect(report.order).toEqual(["core", "lib", "app"]);
  for (const item of report.modules) {
    expect(item.sha256).toBe(hash(byId(input, item.id).bytes));
    expect(item.isolated).toEqual({ memories: 1, tables: 0, usesWasi: item.id === "core" });
    expect(item.checks).toEqual({ declaration: "passed", identity: "passed", interface: "passed", feature: "passed",
      wasiAbi: item.id === "core" ? "passed" : "not-observed", resourceTopology: "passed", engine: "passed",
      targetProvenance: "not-run", pointerContracts: "not-run", handleIsolation: "not-run", environmentIsolation: "not-run",
      hostImplementation: "not-run", lifecycle: "not-run", runtime: "not-run" });
  }
  expect(report.modules.find((item) => item.id === "core")!.wasi.imports).toEqual(["fd_write"]);
  expect(report.modules.find((item) => item.id === "app")!.wasi.evidence).toBe("absent");
});

test("graph failures identify resource, WASI, feature and identity boundaries", async () => {
  let input = fixture();
  byId(input, "app").manifest.artifact.sha256 = "0".repeat(64);
  await expect(inspectFeatureModuleGraph(input, options)).rejects.toThrow("SHA-256 mismatch");
  input = fixture();
  byId(input, "app").manifest.requires[1].version = 2;
  await expect(inspectFeatureModuleGraph(input, options)).rejects.toThrow("interface mismatch");
  input = fixture();
  byId(input, "core").manifest.requires.push({ provider: "lib", interface: "lib", version: 1, imports: [] });
  await expect(inspectFeatureModuleGraph(input, options)).rejects.toThrow("dependency cycle");
  input = fixture();
  byId(input, "app").manifest.target.features = ["simd"];
  await expect(inspectFeatureModuleGraph(input, options)).rejects.toMatchObject({ moduleId: "app", stage: "feature" });
  input = fixture();
  byId(input, "app").manifest.target.features = ["unknown"];
  await expect(inspectFeatureModuleGraph(input, options)).rejects.toMatchObject({ moduleId: "app", stage: "feature" });

  const starts = wasm(section(1, vec([0x60, 0, 0])), section(3, vec([0])), section(8, [0]), section(10, vec(body(0x00))));
  input = { modules: [{ manifest: manifest("start", "app", starts, [], []), bytes: starts }], hosts: [] };
  await expect(inspectFeatureModuleGraph(input, options)).rejects.toMatchObject({ moduleId: "start", stage: "resource" });

  const importedMemory = wasm(section(2, vec(imported("host", "memory", 2, 1, 1, 4))));
  const memoryHost = { id: "host.memory", interface: { name: "memory", version: 1 }, exports: [exportedType("memory", memory)] };
  const memoryRequirement = { provider: "host.memory", interface: "memory", version: 1,
    imports: [required("host", "memory", "memory", memory)] };
  input = { modules: [{ manifest: manifest("shared", "app", importedMemory, [memoryRequirement], []), bytes: importedMemory }], hosts: [memoryHost] };
  await expect(inspectFeatureModuleGraph(input, options)).rejects.toMatchObject({ moduleId: "shared", stage: "resource" });

  const wrongWasi = wasm(section(1, vec([0x60, 0, 1, 0x7f])),
    section(2, vec(imported("wasi_snapshot_preview1", "fd_write", 0, 0))), section(5, vec([1, 1, 4])),
    section(7, vec(exported("memory", 2, 0))));
  const wasiHost = { id: "host.wasi", interface: { name: "wasi", version: 1 }, exports: [exportedType("fd_write", fn)] };
  const requirement = { provider: "host.wasi", interface: "wasi", version: 1,
    imports: [required("wasi_snapshot_preview1", "fd_write", "fd_write", fn)] };
  input = { modules: [{ manifest: manifest("bad-wasi", "app", wrongWasi, [requirement], [exportedType("memory", memory)]), bytes: wrongWasi }], hosts: [wasiHost] };
  await expect(inspectFeatureModuleGraph(input, options)).rejects.toMatchObject({ moduleId: "bad-wasi", stage: "wasi" });
});

test("declared features are checked against binary instructions and trusted host policy", async () => {
  const bytes = await Bun.file("target/validator/fixtures/simd.wasm").bytes();
  const item = manifest("simd", "app", bytes, [], []);
  const input = { modules: [{ manifest: item, bytes }], hosts: [] };
  await expect(inspectFeatureModuleGraph(input, { ...options, allowedFeatures: ["simd"] })).rejects.toMatchObject({ moduleId: "simd", stage: "feature" });
  item.target.features = ["simd"];
  await expect(inspectFeatureModuleGraph(input, options)).rejects.toMatchObject({ moduleId: "simd", stage: "feature" });
  expect((await inspectFeatureModuleGraph(input, { ...options, allowedFeatures: ["simd"] })).modules[0]!.checks.feature).toBe("passed");
});

test("the full graph and host policy are captured before the first asynchronous validation", async () => {
  class SnapshotWorker {
    onmessage: ((event: MessageEvent) => void) | null = null;
    onmessageerror = null;
    onerror = null;
    constructor() { queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } } as MessageEvent)); }
    postMessage(data: { bytes: ArrayBuffer }): void {
      const inputSha256 = hash(new Uint8Array(data.bytes));
      queueMicrotask(() => this.onmessage?.({ data: { type: "result", accepted: true, inputSha256 } } as MessageEvent));
    }
    terminate(): void {}
  }
  useWorker(SnapshotWorker as unknown as typeof Worker);
  {
    const input = fixture(), allowed = ["simd"], expected = new Map(input.modules.map((item: any) => [item.manifest.id, hash(item.bytes)]));
    byId(input, "app").manifest.target.features = ["simd"];
    const pending = inspectFeatureModuleGraph(input, { ...options, allowedFeatures: allowed });
    for (const item of input.modules) { item.bytes.fill(0); item.manifest.target.features.push("unknown"); }
    allowed.length = 0;
    input.hosts[0].interface.version = 9;
    const report = await pending;
    expect(report.order).toEqual(["core", "lib", "app"]);
    expect(report.modules.map((item) => item.sha256)).toEqual(report.modules.map((item) => expected.get(item.id)));
    expect(report.modules.find((item) => item.id === "app")!.declaredFeatures).toEqual(["simd"]);
  }
});

test("graph abort and worker capacity errors remain distinct", async () => {
  class WaitingWorker {
    onmessage = null;
    onmessageerror = null;
    onerror = null;
    terminate(): void {}
  }
  useWorker(WaitingWorker as unknown as typeof Worker);
  {
    const first = new AbortController(), second = new AbortController();
    const a = inspectFeatureModuleGraph(fixture(), { ...options, signal: first.signal });
    const b = inspectFeatureModuleGraph(fixture(), { ...options, signal: second.signal });
    const rejected = fixture();
    Object.defineProperty(rejected.modules[0], "bytes", { enumerable: true, get() { throw new Error("must not read input"); } });
    await expect(inspectFeatureModuleGraph(rejected, options)).rejects.toMatchObject({ code: "busy" });
    const aCheck = a.catch((error: unknown) => error);
    const bCheck = b.catch((error: unknown) => error);
    first.abort(); second.abort();
    expect(await aCheck).toMatchObject({ moduleId: "app", stage: "feature", cause: { code: "aborted" } });
    expect(await bCheck).toMatchObject({ moduleId: "app", stage: "feature", cause: { code: "aborted" } });
    await expect(inspectFeatureModuleGraph(fixture(), { ...options, signal: first.signal })).rejects.toMatchObject({ code: "aborted" });
  }
});
