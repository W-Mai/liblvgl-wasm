import { FeatureValidationError, NumericWasiExit, WASM_FEATURE_POLICY_NAMES, inspectFeatureModuleGraph, loadNumericEnvironment, validateWasmFeatures, type NumericEnvironmentOptions, type NumericWasiOptions } from "liblvgl-wasm/feature-validator";
import { inspectWasmFacts, type ModuleManifestInput } from "liblvgl-wasm";
import { exerciseLvgl } from "./lvgl-module.js";

const coreFeatures = ["bulk-memory", "reference-types", "sign-extension", "saturating-float-to-int", "exceptions"];
const simd = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 22, 1, 20, 0, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11]);

function moduleGraph(): ModuleManifestInput {
  const leb = (value: number): number[] => { const out: number[] = []; do { const byte = value % 128; value = Math.floor(value / 128); out.push(byte | (value ? 128 : 0)); } while (value); return out; };
  const text = (value: string): number[] => { const bytes = [...new TextEncoder().encode(value)]; return [...leb(bytes.length), ...bytes]; };
  const vec = (...entries: number[][]): number[] => [...leb(entries.length), ...entries.flat()];
  const section = (id: number, payload: number[]): number[] => [id, ...leb(payload.length), ...payload];
  const wasm = (...sections: number[][]): Uint8Array<ArrayBuffer> => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, ...sections.flat()]);
  const imported = (module: string, name: string) => [...text(module), ...text(name), 0, 0];
  const exported = (name: string, kind: number, index: number) => [...text(name), kind, ...leb(index)];
  const body = (...instructions: number[]) => { const bytes = [0, ...instructions, 11]; return [...leb(bytes.length), ...bytes]; };
  const type = section(1, vec([0x60, 0, 1, 0x7f], [0x60, 1, 0x7f, 1, 0x7f])), memory = section(5, vec([1, 1, 4]));
  const core = wasm(type, section(3, vec([0], [0], [0])), memory, section(7, vec(exported("get", 0, 0), exported("module_init", 0, 1), exported("module_close", 0, 2), exported("memory", 2, 0))), section(10, vec(body(0x41, 1), body(0x41, 0), body(0x41, 0))));
  const lib = wasm(type, section(2, vec(imported("core", "get"))), section(3, vec([0], [0], [0])), memory, section(7, vec(exported("get", 0, 1), exported("module_init", 0, 2), exported("module_close", 0, 3), exported("memory", 2, 0))), section(10, vec(body(0x10, 0), body(0x41, 0), body(0x41, 0))));
  const app = wasm(type, section(2, vec(imported("core", "get"), imported("lib", "get"))), section(3, vec([1], [0], [0])), memory, section(7, vec(exported("app_run", 0, 2), exported("module_init", 0, 3), exported("module_close", 0, 4), exported("memory", 2, 0))), section(10, vec(body(0x10, 0, 0x10, 1, 0x6a, 0x20, 0, 0x6a), body(0x41, 0), body(0x41, 0))));
  const fn = { kind: "function", params: [], results: ["i32"] } as const;
  const run = { kind: "function", params: ["i32"], results: ["i32"] } as const;
  const mem = { kind: "memory", minimumPages: 1, maximumPages: 4, shared: false } as const;
  const requirement = (provider: string) => ({ provider, interface: provider, version: 1,
    imports: [{ module: provider, name: "get", provider_export: "get", ...fn }] });
  const item = (id: string, role: "lib" | "app", bytes: Uint8Array<ArrayBuffer>, requires: ReturnType<typeof requirement>[]) => ({
    manifest: { schema_version: 1 as const, kind: "wasm-module" as const, id, role,
      artifact: { path: `${id}.wasm`, sha256: inspectWasmFacts(bytes).sha256 }, target: { abi: "wasip1" as const, features: [] },
      interface: { name: id, version: 1 }, memory_model: "isolated" as const, requires,
      exports: [id === "app" ? { name: "app_run", ...run } : { name: "get", ...fn },
        { name: "module_init", ...fn }, { name: "module_close", ...fn }, { name: "memory", ...mem }], runtime_verification: "not-run" as const }, bytes,
  });
  return { modules: [item("app", "app", app, [requirement("core"), requirement("lib")]),
    item("lib", "lib", lib, [requirement("core")]), item("core", "lib", core, [])], hosts: [] };
}

async function rejected(promise: Promise<unknown>): Promise<string> {
  try { await promise; throw new Error("unexpected acceptance"); }
  catch (error) { if (!(error instanceof FeatureValidationError)) throw error; return error.code; }
}

export async function exercise(core: ArrayBuffer, wasiApp: ArrayBuffer, lvProvider: ArrayBuffer, lvApp: ArrayBuffer) {
  const options = { startupTimeoutMs: 10_000, executionTimeoutMs: 10_000 };
  const input = new Uint8Array(core), original = input.slice();
  const pending = validateWasmFeatures(input, { ...options, declaredFeatures: coreFeatures, allowedFeatures: coreFeatures });
  input.fill(0);
  const report = await pending;
  const coreDenied = await rejected(validateWasmFeatures(original, { ...options, declaredFeatures: [], allowedFeatures: coreFeatures }));
  const simdResult = await validateWasmFeatures(simd, { ...options, declaredFeatures: ["simd"], allowedFeatures: ["simd"] });
  const spoofed = new Uint8Array([...simd, 0, 17, 15, ...new TextEncoder().encode("target_features"), 0]);
  const simdDenied = await rejected(validateWasmFeatures(spoofed, { ...options, declaredFeatures: [], allowedFeatures: ["simd"] }));
  const policyDenied = await rejected(validateWasmFeatures(simd, { ...options, declaredFeatures: ["simd"], allowedFeatures: [] }));
  const abort = new AbortController();
  abort.abort();
  const aborted = await rejected(validateWasmFeatures(simd, { ...options, declaredFeatures: [], allowedFeatures: [], signal: abort.signal }));
  const graph = moduleGraph();
  const graphPending = inspectFeatureModuleGraph(graph, { ...options, allowedFeatures: [] });
  for (const item of graph.modules) (item.bytes as Uint8Array).fill(0);
  const graphReport = await graphPending;
  const numericGraph = moduleGraph();
  const numericOptions: NumericEnvironmentOptions = { ...options, profile: "numeric-v1", allowedFeatures: [], hosts: [],
    modules: numericGraph.modules.map(({ manifest }) => ({ id: manifest.id, sha256: manifest.artifact.sha256, interface: manifest.interface,
      exports: manifest.role === "lib" ? [{ name: "get", params: [], results: ["i32" as const] }] : [] })),
    maxMemoryPages: 4, maxTotalMemoryPages: 12, maxTableElements: 0, maxTotalTableElements: 0 };
  const numericPending = loadNumericEnvironment(numericGraph, numericOptions);
  for (const item of numericGraph.modules) (item.bytes as Uint8Array).fill(0);
  const numeric = await numericPending;
  const numericResult = numeric.run(5);
  numeric.close();
  const cBytes = new Uint8Array(wasiApp), cFacts = inspectWasmFacts(cBytes);
  const wasiFunction = { name: "fd_write", kind: "function", params: ["i32", "i32", "i32", "i32"], results: ["i32"] } as const;
  const noArgs = { kind: "function", params: [], results: ["i32"] } as const;
  const cManifest: ModuleManifestInput["modules"][number]["manifest"] = { schema_version: 1 as const, kind: "wasm-module" as const, id: "c", role: "app" as const,
    artifact: { path: "c.wasm", sha256: cFacts.sha256 }, target: { abi: "wasip1" as const, features: [] },
    interface: { name: "c", version: 1 }, memory_model: "isolated" as const, runtime_verification: "not-run" as const,
    requires: [{ provider: "host.wasi", interface: "wasi", version: 1,
      imports: [{ ...wasiFunction, module: "wasi_snapshot_preview1", provider_export: "fd_write" }] }],
    exports: [{ name: "_initialize", kind: "function" as const, params: [], results: [] },
      { name: "module_init", ...noArgs }, { name: "module_close", ...noArgs },
      { name: "app_run", kind: "function" as const, params: ["i32"], results: ["i32"] },
      { name: "memory", kind: "memory" as const, minimumPages: 2, maximumPages: 4, shared: false }] };
  const output: string[] = [], environmentIds: symbol[] = [];
  const wasiOptions: NumericWasiOptions = { id: "host.wasi", interface: { name: "wasi", version: 1 }, allowed: ["fd_write"],
    outputFds: [1, 2], maxIovecs: 4, maxWriteBytes: 32, maxOutputBytes: 64,
    onWrite: (consumer, fd, bytes, environmentId) => { output.push(`${consumer}:${fd}:${new TextDecoder().decode(bytes)}`); environmentIds.push(environmentId); } };
  const wasi = await loadNumericEnvironment({ modules: [{ manifest: cManifest, bytes: cBytes }],
    hosts: [{ id: "host.wasi", interface: { name: "wasi", version: 1 }, exports: [wasiFunction] }] },
    { ...options, profile: "numeric-v1", allowedFeatures: [], modules: [{ id: "c", sha256: cFacts.sha256, interface: cManifest.interface, exports: [] }],
      hosts: [], wasi: wasiOptions, maxMemoryPages: 4, maxTotalMemoryPages: 4, maxTableElements: 1, maxTotalTableElements: 1 });
  const wasiResult = wasi.run(5);
  wasi.close();
  const lvgl = await exerciseLvgl(lvProvider, lvApp);
  return { report, coreDenied, simdStatus: simdResult.status, simdDenied, policyDenied, aborted,
    numericResult, numericState: numeric.state,
    wasiResult, wasiState: wasi.state, wasiOutput: output, wasiIdentity: environmentIds.length === 3 && new Set(environmentIds).size === 1,
    wasiExit: new NumericWasiExit(42).code === 42, lvgl,
    graphOrder: graphReport.order, graphChecks: graphReport.modules.map((item) => item.checks),
    knownFeatures: WASM_FEATURE_POLICY_NAMES.includes("simd") && Object.isFrozen(WASM_FEATURE_POLICY_NAMES),
    rootExport: inspectWasmFacts(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).imports.length === 0 };
}
