import { loadNumericEnvironment, type NumericEnvironmentOptions } from "liblvgl-wasm/feature-validator";
import { inspectWasmFacts, type ModuleExport, type ModuleManifest, type ModuleManifestInput, type WasmExternal, type WasmFacts } from "liblvgl-wasm";

function descriptor(facts: WasmFacts, item: WasmExternal & { readonly name: string }): ModuleExport {
  if (item.kind === "function" || item.kind === "tag") return { name: item.name, kind: item.kind, ...facts.types[item.typeIndex]! };
  return { name: item.name, kind: item.kind, ...item.type } as ModuleExport;
}

function contract(item: ModuleExport) {
  if (item.kind !== "function" || item.params.some((type) => type !== "i32") || item.results.some((type) => type !== "i32")) {
    throw new Error(`unsupported numeric fixture signature: ${item.name}`);
  }
  return { name: item.name, params: item.params as readonly "i32"[], results: item.results as readonly "i32"[] };
}

/** Run a statically linked LVGL provider through the relocated numeric SDK. */
export async function exerciseLvgl(provider: ArrayBuffer, application: ArrayBuffer) {
  const providerBytes = new Uint8Array(provider), appBytes = new Uint8Array(application);
  const core = inspectWasmFacts(providerBytes), app = inspectWasmFacts(appBytes);
  const coreExports = core.exports.map((item) => descriptor(core, item));
  const hostFunctions = (namespace: string) => core.imports.filter((item) => item.module === namespace).map((item) => descriptor(core, item));
  const wasi = hostFunctions("wasi_snapshot_preview1"), lvw = hostFunctions("lvw");
  const requiredLvw = ["observer_release", "decoder_release", "event", "timer", "timer_release", "anim_query", "anim_notify", "anim_release", "anim_exec", "observer", "decoder_info", "decoder_open", "decoder_area", "decoder_close"];
  const requiredWasi = ["environ_get", "environ_sizes_get", "clock_time_get", "fd_close", "fd_seek", "fd_write", "proc_exit"];
  if (lvw.length !== requiredLvw.length || lvw.some((item) => !requiredLvw.includes(item.name))
      || wasi.length !== requiredWasi.length || wasi.some((item) => !requiredWasi.includes(item.name))) throw new Error("unexpected LVGL fixture imports");
  const requirement = (providerId: string, iface: string, facts: WasmFacts, imports: typeof facts.imports) => ({ provider: providerId, interface: iface, version: 1,
    imports: imports.map((item) => ({ ...descriptor(facts, item), module: item.module, provider_export: item.name })) });
  const traceSignature = { name: "lifecycle", kind: "function", params: ["i32"], results: [] } as const;
  const coreManifest: ModuleManifest = { schema_version: 1, kind: "wasm-module", id: "lvcore", role: "lib",
    artifact: { path: "provider.wasm", sha256: core.sha256 }, target: { abi: "wasip1", features: ["bulk-memory", "reference-types", "sign-extension", "saturating-float-to-int", "exceptions"] },
    interface: { name: "lvcore", version: 1 }, memory_model: "isolated", runtime_verification: "not-run",
    requires: [requirement("host.wasi", "wasi", core, core.imports.filter((item) => item.module === "wasi_snapshot_preview1")),
      requirement("host.lvw", "lvw", core, core.imports.filter((item) => item.module === "lvw")),
      requirement("host.trace", "trace", core, core.imports.filter((item) => item.module === "trace"))], exports: coreExports };
  const appManifest: ModuleManifest = { schema_version: 1, kind: "wasm-module", id: "app", role: "app",
    artifact: { path: "app.wasm", sha256: app.sha256 }, target: { abi: "wasip1", features: [] },
    interface: { name: "app", version: 1 }, memory_model: "isolated", runtime_verification: "not-run",
    requires: [requirement("lvcore", "lvcore", app, app.imports.filter((item) => item.module === "lvcore")),
      requirement("host.trace", "trace", app, app.imports.filter((item) => item.module === "trace"))],
    exports: app.exports.map((item) => descriptor(app, item)) };
  const input: ModuleManifestInput = { modules: [{ manifest: appManifest, bytes: appBytes }, { manifest: coreManifest, bytes: providerBytes }],
    hosts: [{ id: "host.wasi", interface: { name: "wasi", version: 1 }, exports: wasi },
      { id: "host.lvw", interface: { name: "lvw", version: 1 }, exports: lvw },
      { id: "host.trace", interface: { name: "trace", version: 1 }, exports: [traceSignature] }] };
  const events: { id: symbol; code: number }[] = [];
  let unexpectedCallbacks = 0, outputBytes = 0;
  const lvwContracts = lvw.map(contract);
  const business = ["bar_set", "bar_get", "frame_pixel", "frame_green"].map((name) => {
    const item = coreExports.find((entry) => entry.name === name);
    if (!item) throw new Error(`missing LVGL fixture export: ${name}`);
    return contract(item);
  });
  const options: NumericEnvironmentOptions = { profile: "numeric-v1", modules: [
    { id: "lvcore", sha256: core.sha256, interface: coreManifest.interface, exports: business },
    { id: "app", sha256: app.sha256, interface: appManifest.interface, exports: [] }],
    hosts: [{ id: "host.lvw", interface: { name: "lvw", version: 1 }, exports: lvwContracts,
      create: () => ({ exports: Object.fromEntries(lvwContracts.map(({ name }) => [name, () => { unexpectedCallbacks++; throw new Error(`unexpected LVGL callback: ${name}`); }])), close: () => {} }) },
      { id: "host.trace", interface: { name: "trace", version: 1 }, exports: [{ name: "lifecycle", params: ["i32"], results: [] }],
        create: (_consumer, id) => ({ exports: { lifecycle: (code: number) => { events.push({ id, code }); } }, close: () => {} }) }],
    wasi: { id: "host.wasi", interface: { name: "wasi", version: 1 }, allowed: ["environ_get", "environ_sizes_get", "clock_time_get", "fd_close", "fd_seek", "fd_write", "proc_exit"],
      outputFds: [1, 2], maxIovecs: 128, maxWriteBytes: 65536, maxOutputBytes: 65536,
      clock: { realtimeNs: 0n, monotonicNs: 0n }, onWrite: (_consumer, _fd, bytes) => { outputBytes += bytes.byteLength; } },
    allowedFeatures: ["bulk-memory", "reference-types", "sign-extension", "saturating-float-to-int", "exceptions"],
    startupTimeoutMs: 30_000, executionTimeoutMs: 30_000,
    maxMemoryPages: 4096, maxTotalMemoryPages: 4128, maxTableElements: 1103, maxTotalTableElements: 1104 };
  const first = await loadNumericEnvironment(input, options);
  let second: Awaited<ReturnType<typeof loadNumericEnvironment>> | undefined;
  try {
    second = await loadNumericEnvironment(input, options);
    const values = [first.run(37), second.run(81), first.run(-101), second.run(-101), first.run(-100), second.run(-100), first.run(101)];
    const green = [first.run(-102), second.run(-102)];
    if (values.join() !== [37, 81, 37, 81, 0x336699, 0x336699, -1].join() || green.join() !== [16, 48].join()) {
      throw new Error(`unexpected LVGL fixture result: ${JSON.stringify({ values, green })}`);
    }
    first.close();
    const survivesClose = second.run(-101);
    let closedRejected = false;
    try { first.run(1); } catch { closedRejected = true; }
    second.close();
    if (survivesClose !== 81 || !closedRejected) throw new Error("unexpected LVGL fixture close behavior");
    const ids = [...new Set(events.map((event) => event.id))];
    if (ids.length !== 2 || events.map((event) => event.code).join() !== [10, 20, 10, 20, 21, 11, 21, 11].join()
        || events.some((event, index) => event.id !== ids[index < 2 || index === 4 || index === 5 ? 0 : 1])) {
      throw new Error("unexpected LVGL fixture lifecycle");
    }
    if (unexpectedCallbacks || outputBytes) throw new Error("unexpected LVGL fixture host traffic");
    return { values, green, environments: ids.length, lifecycle: events.map((event) => event.code), callbacks: unexpectedCallbacks, outputBytes, survivesClose, closedRejected };
  } finally {
    if (first.state === "ready") first.close();
    if (second?.state === "ready") second.close();
  }
}
