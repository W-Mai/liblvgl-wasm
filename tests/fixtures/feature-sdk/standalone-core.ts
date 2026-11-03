import { loadNumericEnvironment, type NumericEnvironmentOptions } from "liblvgl-wasm/feature-validator";
import { inspectWasmFacts, type ModuleExport, type ModuleManifest, type ModuleManifestInput, type WasmExternal, type WasmFacts } from "liblvgl-wasm";

function descriptor(facts: WasmFacts, item: WasmExternal & { readonly name: string }): ModuleExport {
  if (item.kind === "function" || item.kind === "tag") return { name: item.name, kind: item.kind, ...facts.types[item.typeIndex]! };
  return { name: item.name, kind: item.kind, ...item.type } as ModuleExport;
}

export async function exerciseStandaloneCore(coreInput: ArrayBuffer, appInput: ArrayBuffer) {
  const coreBytes = new Uint8Array(coreInput), appBytes = new Uint8Array(appInput);
  const core = inspectWasmFacts(coreBytes), app = inspectWasmFacts(appBytes);
  const iface = (name: string) => ({ name, version: 1 });
  const imports = (facts: WasmFacts, namespace: string) => facts.imports.filter((item) => item.module === namespace);
  const requirement = (provider: string, interfaceName: string, facts: WasmFacts, items: WasmFacts["imports"]) => ({
    provider, interface: interfaceName, version: 1,
    imports: items.map((item) => ({ ...descriptor(facts, item), module: item.module, provider_export: item.name })),
  });
  const wasiImports = imports(core, "wasi_snapshot_preview1"), lvwImports = imports(core, "lvw"), appImports = imports(app, "lvcore");
  if (wasiImports.length !== 7 || lvwImports.length !== 14 || appImports.length !== 1 || appImports[0]!.name !== "lv_is_initialized") {
    throw new Error("unexpected standalone LVGL fixture imports");
  }
  const features = ["bulk-memory", "reference-types", "sign-extension", "saturating-float-to-int", "exceptions"];
  const coreManifest: ModuleManifest = { schema_version: 1, kind: "wasm-module", id: "lvcore", role: "lib",
    artifact: { path: "lvcore.wasm", sha256: core.sha256 }, target: { abi: "wasip1", features }, interface: iface("lvcore"),
    memory_model: "isolated", runtime_verification: "not-run", exports: core.exports.map((item) => descriptor(core, item)),
    requires: [requirement("host.wasi", "wasi", core, wasiImports), requirement("host.lvw", "lvw", core, lvwImports)] };
  const appManifest: ModuleManifest = { schema_version: 1, kind: "wasm-module", id: "app", role: "app",
    artifact: { path: "app.wasm", sha256: app.sha256 }, target: { abi: "wasip1", features: [] }, interface: iface("app"),
    memory_model: "isolated", runtime_verification: "not-run", exports: app.exports.map((item) => descriptor(app, item)),
    requires: [requirement("lvcore", "lvcore", app, appImports)] };
  const wasiExports = wasiImports.map((item) => descriptor(core, item)), lvwExports = lvwImports.map((item) => descriptor(core, item));
  const input: ModuleManifestInput = { modules: [{ manifest: appManifest, bytes: appBytes }, { manifest: coreManifest, bytes: coreBytes }],
    hosts: [{ id: "host.wasi", interface: iface("wasi"), exports: wasiExports }, { id: "host.lvw", interface: iface("lvw"), exports: lvwExports }] };
  const memory = [...core.memories, ...app.memories].map((item) => item.type.maximumPages);
  const table = [...core.tables, ...app.tables].map((item) => item.type.maximum);
  if (memory.some((value) => value === null) || table.some((value) => value === null)) throw new Error("fixture resources are not bounded");
  const options: NumericEnvironmentOptions = { profile: "lvgl-core-v1", lvgl: { module: "lvcore", id: "host.lvw", interface: iface("lvw"), abiVersion: 1 },
    modules: [{ id: "lvcore", sha256: core.sha256, interface: iface("lvcore"), exports: [{ name: "lv_is_initialized", params: [], results: ["i32"] }] },
      { id: "app", sha256: app.sha256, interface: iface("app"), exports: [] }], hosts: [],
    wasi: { id: "host.wasi", interface: iface("wasi"), allowed: ["environ_get", "environ_sizes_get", "clock_time_get", "fd_close", "fd_seek", "fd_write", "proc_exit"],
      outputFds: [], maxIovecs: 16, maxWriteBytes: 4096, maxOutputBytes: 4096, clock: { realtimeNs: 0n, monotonicNs: 0n },
      onWrite: () => { throw new Error("unexpected WASI output"); } },
    allowedFeatures: features, startupTimeoutMs: 30_000, executionTimeoutMs: 30_000,
    maxMemoryPages: Math.max(...memory as number[]), maxTotalMemoryPages: (memory as number[]).reduce((sum, value) => sum + value, 0),
    maxTableElements: Math.max(...table as number[]), maxTotalTableElements: (table as number[]).reduce((sum, value) => sum + value, 0) };
  const first = await loadNumericEnvironment(input, options);
  let second: Awaited<ReturnType<typeof loadNumericEnvironment>> | undefined;
  try {
    second = await loadNumericEnvironment(input, options);
    const values = [first.run(5), second.run(9)];
    first.close();
    values.push(second.run(7));
    second.close();
    return { values, states: [first.state, second.state] };
  } finally {
    if (first.state === "ready") first.close();
    if (second?.state === "ready") second.close();
  }
}

export async function exerciseLabelCore(coreInput: ArrayBuffer, appInput: ArrayBuffer, events = false) {
  const coreBytes = new Uint8Array(coreInput), appBytes = new Uint8Array(appInput);
  const core = inspectWasmFacts(coreBytes), app = inspectWasmFacts(appBytes);
  const iface = (name: string) => ({ name, version: 1 });
  const imports = (facts: WasmFacts, namespace: string) => facts.imports.filter((item) => item.module === namespace);
  const requirement = (provider: string, interfaceName: string, facts: WasmFacts, items: WasmFacts["imports"]) => ({
    provider, interface: interfaceName, version: 1,
    imports: items.map((item) => ({ ...descriptor(facts, item), module: item.module, provider_export: item.name })),
  });
  const wasiImports = imports(core, "wasi_snapshot_preview1"), lvwImports = imports(core, "lvw"), labelImports = imports(app, "lvgl");
  if (wasiImports.length !== 7 || lvwImports.length !== 14 || labelImports.length !== (events ? 9 : 3)) throw new Error("unexpected label fixture imports");
  const features = ["bulk-memory", "reference-types", "sign-extension", "saturating-float-to-int", "exceptions"];
  const coreManifest: ModuleManifest = { schema_version: 1, kind: "wasm-module", id: "lvcore", role: "lib",
    artifact: { path: "lvcore.wasm", sha256: core.sha256 }, target: { abi: "wasip1", features }, interface: iface("lvcore"),
    memory_model: "isolated", runtime_verification: "not-run", exports: core.exports.map((item) => descriptor(core, item)),
    requires: [requirement("host.wasi", "wasi", core, wasiImports), requirement("host.lvw", "lvw", core, lvwImports)] };
  const appManifest: ModuleManifest = { schema_version: 1, kind: "wasm-module", id: "app", role: "app",
    artifact: { path: "app.wasm", sha256: app.sha256 }, target: { abi: "wasip1", features: events ? ["reference-types"] : ["bulk-memory"] }, interface: iface("app"),
    memory_model: "isolated", runtime_verification: "not-run", exports: app.exports.map((item) => descriptor(app, item)),
    requires: [requirement("lvcore", "lvcore", app, []), requirement("host.label", "lvgl", app, labelImports)] };
  const wasiExports = wasiImports.map((item) => descriptor(core, item)), lvwExports = lvwImports.map((item) => descriptor(core, item));
  const input: ModuleManifestInput = { modules: [{ manifest: appManifest, bytes: appBytes }, { manifest: coreManifest, bytes: coreBytes }],
    hosts: [{ id: "host.wasi", interface: iface("wasi"), exports: wasiExports }, { id: "host.lvw", interface: iface("lvw"), exports: lvwExports },
      { id: "host.label", interface: iface("lvgl"), exports: labelImports.map((item) => descriptor(app, item)) }] };
  const memory = [...core.memories, ...app.memories].map((item) => item.type.maximumPages);
  const table = [...core.tables, ...app.tables].map((item) => item.type.maximum);
  if (memory.some((value) => value === null) || table.some((value) => value === null)) throw new Error("fixture resources are not bounded");
  const options: NumericEnvironmentOptions = { profile: events ? "lvgl-event-v1" : "lvgl-label-v1", lvgl: { module: "lvcore", id: "host.lvw", interface: iface("lvw"), abiVersion: 1 },
    label: { id: "host.label", interface: iface("lvgl"), width: 120, height: 48, maxLabels: 8, maxTextBytes: 4096 },
    ...(events ? { event: { maxRegistrations: 8, maxDepth: 8 } } : {}),
    modules: [{ id: "lvcore", sha256: core.sha256, interface: iface("lvcore"), exports: [] }, { id: "app", sha256: app.sha256, interface: iface("app"), exports: [] }], hosts: [],
    wasi: { id: "host.wasi", interface: iface("wasi"), allowed: ["environ_get", "environ_sizes_get", "clock_time_get", "fd_close", "fd_seek", "fd_write", "proc_exit"],
      outputFds: [], maxIovecs: 16, maxWriteBytes: 4096, maxOutputBytes: 4096, clock: { realtimeNs: 0n, monotonicNs: 0n }, onWrite: () => { throw new Error("unexpected WASI output"); } },
    allowedFeatures: features, startupTimeoutMs: 30_000, executionTimeoutMs: 30_000,
    maxMemoryPages: Math.max(...memory as number[]), maxTotalMemoryPages: (memory as number[]).reduce((sum, value) => sum + value, 0),
    maxTableElements: Math.max(...table as number[]), maxTotalTableElements: (table as number[]).reduce((sum, value) => sum + value, 0) };
  const first = await loadNumericEnvironment(input, options);
  let second: Awaited<ReturnType<typeof loadNumericEnvironment>> | undefined;
  try {
    second = await loadNumericEnvironment(input, options);
    if (!first.readFrame || !second.readFrame) throw new Error("missing label frame operation");
    const oldFrame = first.readFrame(), otherFrame = second.readFrame();
    if (events ? first.run(1) !== 2 || first.run(4) !== 1 : first.run(-1) !== 0) throw new Error("label update failed");
    const frame = first.readFrame();
    const framesDiffer = oldFrame.rgba.some((value, index) => value !== frame.rgba[index]);
    const otherAfter = second.readFrame();
    const otherUnchanged = otherFrame.rgba.every((value, index) => value === otherAfter.rgba[index]);
    const removed = events ? first.run(2) === 1 && first.run(3) === 2 : true;
    first.close();
    const survivesClose = events ? second.run(1) === 2 : second.run(-4) === 0;
    second.close();
    if (!framesDiffer || !otherUnchanged || !survivesClose || !removed) throw new Error("unexpected label frame or environment isolation");
    return { width: frame.width, height: frame.height, framesDiffer, otherUnchanged, survivesClose, states: [first.state, second.state] };
  } finally {
    if (first.state === "ready") first.close();
    if (second?.state === "ready") second.close();
  }
}
