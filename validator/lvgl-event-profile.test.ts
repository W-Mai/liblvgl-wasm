import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, test as bunTest } from "bun:test";
import { inspectWasmFacts, type WasmFacts } from "../bindings/typescript/src/wasm-facts.ts";

type Capture = { instance: WebAssembly.Instance; imports: WebAssembly.Imports };
type Frame = { width: number; height: number; frameId: number; rgba: Uint8ClampedArray };
type Environment = Awaited<ReturnType<typeof loadNumericEnvironment>> & { readFrame(): Frame };
type Operation = { controller: AbortController; promise: Promise<Environment> };
type Context = { cores: Capture[]; apps: Capture[]; trace: string[]; ending: boolean; active: Set<Operation>; environments: Set<Environment>; errors: unknown[] };
const contexts = new AsyncLocalStorage<Context>();
let current: Context;
const test = (name: string, body: () => Promise<void>) => bunTest(name, () => {
  const context: Context = { cores: [], apps: [], trace: [], ending: false, active: new Set(), environments: new Set(), errors: [] };
  current = context;
  const completion = contexts.run(context, () => Promise.resolve().then(body));
  return completion.catch((error: unknown) => { if (!context.ending) throw error; });
}, 300_000);

const instanceProperty = Object.getOwnPropertyDescriptor(WebAssembly, "Instance")!;
const proxy = new Proxy(WebAssembly.Instance, {
  construct(target, args) {
    const instance = Reflect.construct(target, args, target) as WebAssembly.Instance;
    const capture = { instance, imports: args[1] as WebAssembly.Imports };
    const context = contexts.getStore();
    const kind = typeof instance.exports.lvw_init === "function" ? "core" : typeof instance.exports.app_run === "function" ? "app" : undefined;
    if (context && kind) {
      if (kind === "core") context.cores.push(capture); else context.apps.push(capture);
      const observed: Record<string, WebAssembly.ExportValue> = { ...instance.exports };
      for (const name of ["module_init", "module_close", "app_event_dispatch", "lvw_event_add", "lvw_event_remove", "lvw_shutdown"]) {
        const fn = instance.exports[name];
        if (typeof fn === "function") observed[name] = (...values: number[]) => {
          context.trace.push(`${kind}.${name}`);
          const result = fn(...values);
          if (kind === "app" && name === "module_close") context.trace.push("app.module_close:return");
          return result;
        };
      }
      return new Proxy(instance, { get(target, key) { return key === "exports" ? observed : Reflect.get(target, key, target); } });
    }
    return instance;
  },
});
let loadNumericEnvironment: typeof import("../target/validator/feature-validator.js").loadNumericEnvironment;
try {
  Object.defineProperty(WebAssembly, "Instance", { ...instanceProperty, value: proxy });
  ({ loadNumericEnvironment } = await import("../target/validator/feature-validator.js?lvgl-event-profile-test"));
} finally {
  Object.defineProperty(WebAssembly, "Instance", instanceProperty);
}

function load(input: unknown, options: any): Promise<Environment> {
  const context = contexts.getStore()!;
  if (context.ending) return Promise.reject(new Error("test cleanup in progress"));
  const controller = new AbortController();
  const promise = loadNumericEnvironment(input as any, { ...options, signal: controller.signal }) as Promise<Environment>;
  const operation = { controller, promise };
  context.active.add(operation);
  const release = () => { context.active.delete(operation); };
  promise.then((environment) => {
    if (context.ending && environment.state === "ready") {
      try { environment.close(); } catch (error) { context.errors.push(error); }
    } else context.environments.add(environment);
    release();
  }, release);
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
      timer = setTimeout(() => reject(new Error("LVGL event test cleanup timed out")), 10_000);
    })]);
  } catch (error) { context.errors.push(error); } finally { clearTimeout(timer); }
  for (const environment of context.environments) {
    if (environment.state !== "ready") continue;
    try { environment.close(); } catch (error) { context.errors.push(error); }
  }
  context.environments.clear();
  if (context.errors.length) throw new AggregateError(context.errors, "LVGL event test cleanup failed");
}, 30_000);

const iface = (name: string) => ({ name, version: 1 });
const features = ["bulk-memory", "reference-types", "sign-extension", "saturating-float-to-int", "exceptions"];
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const native = (capture: Capture, name: string, ...args: number[]) => (capture.instance.exports[name] as (...values: number[]) => number)(...args);

function descriptor(facts: WasmFacts, item: WasmFacts["exports"][number] | WasmFacts["imports"][number]) {
  if (item.kind === "function" || item.kind === "tag") return { name: item.name, kind: item.kind, ...facts.types[item.typeIndex]! };
  return { name: item.name, kind: item.kind, ...item.type };
}

async function coreSnapshot() {
  const core = Bun.file("target/wasm/liblvgl-bounded.wasm"), apiFile = Bun.file("target/wasm/api.json"),
    proofFile = Bun.file("target/wasm/api-verification-bounded.json");
  if (core.size > 64 * 1024 * 1024 || apiFile.size > 32 * 1024 * 1024 || proofFile.size > 1024 * 1024) {
    throw new Error("bounded core input is too large");
  }
  const [coreBytes, apiBytes, proofBytes] = await Promise.all([
    core.bytes(), apiFile.bytes(), proofFile.bytes(),
  ]);
  if (coreBytes.length > 64 * 1024 * 1024 || apiBytes.length > 32 * 1024 * 1024 || proofBytes.length > 1024 * 1024) {
    throw new Error("bounded core input is too large");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const api = JSON.parse(decoder.decode(apiBytes)), proof = JSON.parse(decoder.decode(proofBytes));
  const keys = ["schema_version", "api_sha256", "wasm_sha256", "expected_functions", "verified_functions"];
  if (!api || api.schema_version !== 1 || !Array.isArray(api.declarations) || !api.wasm_summary
      || !proof || typeof proof !== "object" || Array.isArray(proof) || Object.keys(proof).length !== keys.length
      || Object.keys(proof).some((key) => !keys.includes(key)) || proof.schema_version !== 1
      || proof.api_sha256 !== sha256(apiBytes) || proof.wasm_sha256 !== sha256(coreBytes)) {
    throw new Error("bounded core proof does not match its inputs");
  }
  const categories = new Set(["direct_export", "abi_shim", "compile_disabled", "unsupported"]);
  if (api.declarations.some((item: any) => !item || typeof item !== "object" || !categories.has(item.category)
      || typeof item.name !== "string" || !/^lv_[A-Za-z0-9_]+$/.test(item.name))) throw new Error("invalid bounded core API inventory");
  const declarationNames = api.declarations.map((item: any) => item.name);
  if (new Set(declarationNames).size !== declarationNames.length) throw new Error("invalid bounded core API inventory");
  const supported = api.declarations.filter((item: any) => item.category === "direct_export" || item.category === "abi_shim");
  const names = supported.map((item: any) => item.export_name);
  if (!Number.isSafeInteger(proof.expected_functions) || proof.expected_functions <= 0 || proof.expected_functions !== proof.verified_functions
      || proof.expected_functions !== api.wasm_summary.expected_functions || proof.expected_functions !== supported.length
      || names.some((name: unknown) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      || new Set(names).size !== names.length) {
    throw new Error("bounded core proof inventory differs");
  }
  return coreBytes;
}

async function fixture(failInit = false) {
  const coreBytes = await coreSnapshot();
  const appBytes = await Bun.file(`target/validator/lvgl-event-app${failInit ? "-fail-init" : ""}.wasm`).bytes();
  const core = inspectWasmFacts(coreBytes), app = inspectWasmFacts(appBytes);
  const imports = (facts: WasmFacts, namespace: string) => facts.imports.filter((item) => item.module === namespace);
  const requirement = (provider: string, interfaceName: string, facts: WasmFacts, items: WasmFacts["imports"]) => ({
    provider, interface: interfaceName, version: 1, imports: items.map((item) => ({ ...descriptor(facts, item), module: item.module, provider_export: item.name })),
  });
  const manifest = (id: string, role: "app" | "lib", facts: WasmFacts, declaredFeatures: string[], requires: object[]) => ({
    schema_version: 1, kind: "wasm-module", id, role, artifact: { path: `${id}.wasm`, sha256: facts.sha256 },
    target: { abi: "wasip1", features: declaredFeatures }, interface: iface(id), memory_model: "isolated", requires,
    exports: facts.exports.map((item) => descriptor(facts, item)), runtime_verification: "not-run",
  });
  const wasi = imports(core, "wasi_snapshot_preview1"), lvw = imports(core, "lvw"), labels = imports(app, "lvgl");
  expect(wasi).toHaveLength(7);
  expect(lvw).toHaveLength(14);
  expect(labels.map((item) => item.name).sort()).toEqual(["lv_event_get_code", "lv_event_get_target_obj", "lv_event_get_user_data",
    "lv_label_create", "lv_label_set_text", "lv_obj_add_event_cb", "lv_obj_remove_event_dsc", "lv_obj_send_event", "lv_screen_active"]);
  const dispatch = app.exports.find((item) => item.name === "app_event_dispatch");
  if (!dispatch || dispatch.kind !== "function") throw new Error("missing app event dispatcher");
  expect(app.types[dispatch.typeIndex]).toEqual({ params: ["i32", "i32"], results: [] });
  expect(app.functions[dispatch.index]!.imported).toBe(false);
  expect(app.tables).toHaveLength(1);
  expect(app.tables[0]!.imported).toBe(false);
  expect(app.tables[0]!.type.maximum).toBe(app.tables[0]!.type.minimum);
  expect(app.exports.some((item) => item.kind === "table")).toBe(false);
  const memories = [...core.memories, ...app.memories].map((item) => item.type.maximumPages);
  const tables = [...core.tables, ...app.tables].map((item) => item.type.maximum);
  if (memories.some((value) => value === null) || tables.some((value) => value === null)) throw new Error("fixture resources must be bounded");
  expect(core.tables[0]!.type.maximum).toBe(core.tables[0]!.type.minimum);
  const wasiExports = wasi.map((item) => descriptor(core, item));
  const input = { modules: [
    { manifest: manifest("app", "app", app, ["reference-types"], [requirement("lvcore", "lvcore", app, []), requirement("host.label", "lvgl", app, labels)]), bytes: appBytes },
    { manifest: manifest("lvcore", "lib", core, features, [requirement("host.wasi", "wasi", core, wasi), requirement("host.lvw", "lvw", core, lvw)]), bytes: coreBytes },
  ], hosts: [{ id: "host.wasi", interface: iface("wasi"), exports: wasiExports },
    { id: "host.lvw", interface: iface("lvw"), exports: lvw.map((item) => descriptor(core, item)) },
    { id: "host.label", interface: iface("lvgl"), exports: labels.map((item) => descriptor(app, item)) }] };
  const options = { profile: "lvgl-event-v1", lvgl: { module: "lvcore", id: "host.lvw", interface: iface("lvw"), abiVersion: 1 },
    label: { id: "host.label", interface: iface("lvgl"), width: 120, height: 48, maxLabels: 8, maxTextBytes: 4096 },
    event: { maxRegistrations: 8, maxDepth: 8 },
    modules: [{ id: "app", sha256: app.sha256, interface: iface("app"), exports: [] },
      { id: "lvcore", sha256: core.sha256, interface: iface("lvcore"), exports: [] }], hosts: [],
    wasi: { id: "host.wasi", interface: iface("wasi"), allowed: wasiExports.map((item) => item.name), outputFds: [],
      maxIovecs: 16, maxWriteBytes: 4096, maxOutputBytes: 4096, clock: { realtimeNs: 0n, monotonicNs: 0n },
      onWrite: () => { throw new Error("unexpected WASI output"); } },
    allowedFeatures: features, startupTimeoutMs: 30_000, executionTimeoutMs: 30_000,
    maxMemoryPages: Math.max(...memories as number[]), maxTotalMemoryPages: (memories as number[]).reduce((sum, value) => sum + value, 0),
    maxTableElements: Math.max(...tables as number[]), maxTotalTableElements: (tables as number[]).reduce((sum, value) => sum + value, 0) };
  return { input, options };
}

function textBytes(core: Capture): Uint8Array {
  const screen = native(core, "lv_screen_active"), label = native(core, "lv_obj_get_child", screen, 0);
  const pointer = native(core, "lv_label_get_text", label) >>> 0;
  const memory = core.instance.exports.memory as WebAssembly.Memory;
  const bytes = new Uint8Array(memory.buffer), end = bytes.indexOf(0, pointer);
  if (!pointer || end < pointer) throw new Error("invalid native label text");
  return bytes.slice(pointer, end);
}

test("the C app handles nested real events, updates the frame, and unregisters before close", async () => {
  const { cores, apps, trace } = contexts.getStore()!;
  const { input, options } = await fixture();
  const a = await load(input, options), b = await load(input, options);
  expect(Object.keys(a).sort()).toEqual(["close", "readFrame", "run", "state"]);
  expect(cores).toHaveLength(2);
  expect(apps).toHaveLength(2);
  const memories = [...cores, ...apps].map(({ instance }) => instance.exports.memory);
  expect(memories.every((memory) => memory instanceof WebAssembly.Memory)).toBe(true);
  expect(new Set(memories).size).toBe(4);
  expect(new TextDecoder().decode(textBytes(cores[0]!))).toBe("READY");
  expect(new TextDecoder().decode(textBytes(cores[1]!))).toBe("READY");
  const frame = a.readFrame();
  expect([frame.width, frame.height, frame.rgba.length]).toEqual([120, 48, 120 * 48 * 4]);
  const pixels = frame.rgba.slice();
  frame.rgba[0] ^= 0xff;
  expect(a.readFrame().rgba[0]).toBe(pixels[0]);
  expect(a.run(1)).toBe(2);
  expect(a.run(4)).toBe(1);
  expect([5, 6, 7, 8].map((value) => a.run(value))).toEqual([11, 12, 22, 21]);
  expect(new TextDecoder().decode(textBytes(cores[0]!))).toBe("CLICKED");
  expect(new TextDecoder().decode(textBytes(cores[1]!))).toBe("READY");
  expect(a.readFrame().rgba.some((value, index) => value !== pixels[index])).toBe(true);
  expect(trace.filter((item) => item === "app.app_event_dispatch")).toHaveLength(2);
  expect(a.run(2)).toBe(1);
  expect(a.run(3)).toBe(2);
  expect(trace.filter((item) => item === "app.app_event_dispatch")).toHaveLength(2);
  a.close();
  expect(native(cores[0]!, "lv_is_initialized")).toBe(0);
  expect(native(cores[1]!, "lv_is_initialized")).toBe(1);
  expect(() => a.readFrame()).toThrow();
  const beforeClose = trace.length;
  b.close();
  expect(trace.slice(beforeClose)).toEqual(["app.module_close", "core.lvw_event_remove", "app.module_close:return", "core.lvw_shutdown"]);
  expect(native(cores[1]!, "lv_is_initialized")).toBe(0);
});

test("remaining native registration is removed after app close returns and before core shutdown", async () => {
  const { cores, trace } = contexts.getStore()!;
  const { input, options } = await fixture();
  const environment = await load(input, options);
  expect(environment.run(11)).toBe(0);
  const beforeClose = trace.length;
  environment.close();
  expect(trace.slice(beforeClose)).toEqual(["app.module_close", "app.module_close:return", "core.lvw_event_remove", "core.lvw_shutdown"]);
  expect(native(cores[0]!, "lv_is_initialized")).toBe(0);
});

test("app close can synchronously dispatch a supported event before unregistering", async () => {
  const { cores, trace } = contexts.getStore()!;
  const { input, options } = await fixture();
  const environment = await load(input, options);
  expect(environment.run(12)).toBe(0);
  const beforeClose = trace.length;
  environment.close();
  expect(trace.slice(beforeClose)).toEqual(["app.module_close", "app.app_event_dispatch", "app.app_event_dispatch",
    "core.lvw_event_remove", "app.module_close:return", "core.lvw_shutdown"]);
  expect(environment.state).toBe("closed");
  expect(native(cores[0]!, "lv_is_initialized")).toBe(0);
});

test("failed application init unregisters the native callback before core shutdown", async () => {
  const { cores, trace } = contexts.getStore()!;
  const { input, options } = await fixture(true);
  await expect(load(input, options)).rejects.toThrow("module_init returned 7");
  expect(cores).toHaveLength(1);
  expect(trace.filter((item) => item === "core.lvw_event_add")).toHaveLength(1);
  expect(trace.indexOf("core.lvw_event_remove")).toBeGreaterThan(trace.indexOf("core.lvw_event_add"));
  expect(trace.indexOf("core.lvw_shutdown")).toBeGreaterThan(trace.indexOf("core.lvw_event_remove"));
  expect(native(cores[0]!, "lv_is_initialized")).toBe(0);
});

test("a retained callback event token rejects and poisons the environment", async () => {
  const { trace } = contexts.getStore()!;
  const { input, options } = await fixture();
  const environment = await load(input, options);
  expect(environment.run(1)).toBe(2);
  const before = trace.length;
  expect(() => environment.run(-1)).toThrow("invalid LVGL event token");
  expect(environment.state).toBe("poisoned");
  expect(() => environment.close()).toThrow();
  expect(trace.slice(before)).not.toContain("core.lvw_event_remove");
  expect(trace.slice(before)).not.toContain("core.lvw_shutdown");
});

test("removing a registration inside a nested callback preserves active frames", async () => {
  const { trace } = contexts.getStore()!;
  const { input, options } = await fixture();
  const environment = await load(input, options);
  expect(environment.run(9)).toBe(2);
  expect(environment.run(4)).toBe(1);
  expect([5, 6, 7, 8].map((value) => environment.run(value))).toEqual([11, 12, 22, 21]);
  expect(trace.filter((item) => item === "core.lvw_event_remove")).toHaveLength(1);
  expect(environment.run(3)).toBe(2);
  expect(trace.filter((item) => item === "app.app_event_dispatch")).toHaveLength(2);
  environment.close();
  expect(trace.filter((item) => item === "core.lvw_event_remove")).toHaveLength(1);
});

for (const [name, value, error] of [
  ["outer token during inner callback", 10, "invalid LVGL event token"],
  ["non-null event parameter", -3, "unsupported LVGL event dispatch"],
  ["unsupported event code", -5, "unsupported LVGL event dispatch"],
] as const) {
  test(`${name} rejects and poisons without guest cleanup`, async () => {
    const { trace } = contexts.getStore()!;
    const { input, options } = await fixture();
    const environment = await load(input, options);
    const before = trace.length;
    expect(() => environment.run(value)).toThrow(error);
    expect(environment.state).toBe("poisoned");
    expect(() => environment.close()).toThrow(error);
    expect(trace.slice(before)).not.toContain("core.lvw_event_remove");
    expect(trace.slice(before)).not.toContain("core.lvw_shutdown");
  });
}

test("stale descriptor cannot remove another registration", async () => {
  const { input, options } = await fixture();
  const environment = await load(input, options);
  expect(environment.run(2)).toBe(1);
  expect(() => environment.run(-2)).toThrow("invalid LVGL event descriptor");
  expect(environment.state).toBe("poisoned");
});

test("the event and nesting quotas are enforced on the real core", async () => {
  const first = await fixture();
  first.options.event.maxRegistrations = 1;
  const a = await load(first.input, first.options);
  expect(a.run(-6)).toBe(0);
  expect(() => a.run(-4)).toThrow("LVGL event quota exceeded");
  expect(a.state).toBe("poisoned");
  const second = await fixture();
  second.options.event.maxDepth = 1;
  const b = await load(second.input, second.options);
  expect(() => b.run(1)).toThrow("LVGL event nesting limit exceeded");
  expect(b.state).toBe("poisoned");
});

test("foreign label tokens cannot send events in another environment", async () => {
  const { input, options } = await fixture();
  const a = await load(input, options), b = await load(input, options);
  const token = a.run(0);
  expect(token).not.toBe(b.run(0));
  expect(() => b.run(token)).toThrow("invalid LVGL label handle");
  expect(b.state).toBe("poisoned");
  a.close();
});
