import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, test as bunTest } from "bun:test";
import { inspectWasmFacts, type WasmFacts } from "../bindings/typescript/src/wasm-facts.ts";

type Capture = { instance: WebAssembly.Instance; imports: WebAssembly.Imports };
type Frame = { width: number; height: number; frameId: number; rgba: Uint8ClampedArray };
type Environment = Awaited<ReturnType<typeof loadNumericEnvironment>> & { readFrame(): Frame };
type Operation = { controller: AbortController; promise: Promise<Environment> };
type Context = { cores: Capture[]; apps: Capture[]; ending: boolean; active: Set<Operation>; environments: Set<Environment>; errors: unknown[] };
const contexts = new AsyncLocalStorage<Context>();
let current: Context;
const test = (name: string, body: () => Promise<void>) => bunTest(name, () => {
  const context: Context = { cores: [], apps: [], ending: false, active: new Set(), environments: new Set(), errors: [] };
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
    if (context && typeof instance.exports.lvw_init === "function") context.cores.push(capture);
    if (context && typeof instance.exports.app_run === "function") context.apps.push(capture);
    return instance;
  },
});
let loadNumericEnvironment: typeof import("../target/validator/feature-validator.js").loadNumericEnvironment;
try {
  Object.defineProperty(WebAssembly, "Instance", { ...instanceProperty, value: proxy });
  ({ loadNumericEnvironment } = await import("../target/validator/feature-validator.js?lvgl-label-profile-test"));
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
      timer = setTimeout(() => reject(new Error("LVGL label test cleanup timed out")), 10_000);
    })]);
  } catch (error) { context.errors.push(error); } finally { clearTimeout(timer); }
  for (const environment of context.environments) {
    if (environment.state !== "ready") continue;
    try { environment.close(); } catch (error) { context.errors.push(error); }
  }
  context.environments.clear();
  if (context.errors.length) throw new AggregateError(context.errors, "LVGL label test cleanup failed");
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
  const appBytes = await Bun.file(`target/validator/lvgl-label-app${failInit ? "-fail-init" : ""}.wasm`).bytes();
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
  expect(labels.map((item) => item.name).sort()).toEqual(["lv_label_create", "lv_label_set_text", "lv_screen_active"]);
  const memories = [...core.memories, ...app.memories].map((item) => item.type.maximumPages);
  const tables = [...core.tables, ...app.tables].map((item) => item.type.maximum);
  if (memories.some((value) => value === null) || tables.some((value) => value === null)) throw new Error("fixture resources must be bounded");
  expect(core.tables[0]!.type.maximum).toBe(core.tables[0]!.type.minimum);
  const wasiExports = wasi.map((item) => descriptor(core, item));
  const input = { modules: [
    { manifest: manifest("app", "app", app, ["bulk-memory"], [requirement("lvcore", "lvcore", app, []), requirement("host.label", "lvgl", app, labels)]), bytes: appBytes },
    { manifest: manifest("lvcore", "lib", core, features, [requirement("host.wasi", "wasi", core, wasi), requirement("host.lvw", "lvw", core, lvw)]), bytes: coreBytes },
  ], hosts: [{ id: "host.wasi", interface: iface("wasi"), exports: wasiExports },
    { id: "host.lvw", interface: iface("lvw"), exports: lvw.map((item) => descriptor(core, item)) },
    { id: "host.label", interface: iface("lvgl"), exports: labels.map((item) => descriptor(app, item)) }] };
  const options = { profile: "lvgl-label-v1", lvgl: { module: "lvcore", id: "host.lvw", interface: iface("lvw"), abiVersion: 1 },
    label: { id: "host.label", interface: iface("lvgl"), width: 120, height: 48, maxLabels: 8, maxTextBytes: 4096 },
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

test("the C app renders copied label text with isolated core and app memories", async () => {
  const { cores, apps } = contexts.getStore()!;
  const { input, options } = await fixture();
  const a = await load(input, options), b = await load(input, options);
  expect(Object.keys(a).sort()).toEqual(["close", "readFrame", "run", "state"]);
  expect(cores).toHaveLength(2);
  expect(apps).toHaveLength(2);
  const memories = [...cores, ...apps].map(({ instance }) => instance.exports.memory);
  expect(memories.every((memory) => memory instanceof WebAssembly.Memory)).toBe(true);
  expect(new Set(memories).size).toBe(4);
  expect(new TextDecoder().decode(textBytes(cores[0]!))).toBe("ALPHA");
  expect(new TextDecoder().decode(textBytes(cores[1]!))).toBe("ALPHA");
  const frame = a.readFrame();
  expect([frame.width, frame.height, frame.rgba.length]).toEqual([120, 48, 120 * 48 * 4]);
  const pixels = frame.rgba.slice();
  frame.rgba[0] ^= 0xff;
  expect(a.readFrame().rgba[0]).toBe(pixels[0]);
  expect(a.run(-1)).toBe(0);
  expect(new TextDecoder().decode(textBytes(cores[0]!))).toBe("BETA");
  expect(new TextDecoder().decode(textBytes(cores[1]!))).toBe("ALPHA");
  expect(a.readFrame().rgba.some((value, index) => value !== pixels[index])).toBe(true);
  expect(a.run(-3)).toBe(0);
  expect([...textBytes(cores[0]!)]).toEqual([88, 195, 40]);
  expect(a.run(-4)).toBe(0);
  expect([...textBytes(cores[0]!)]).toEqual([88, 195, 40]);
  const memory = apps[0]!.instance.exports.memory as WebAssembly.Memory;
  const before = memory.buffer.byteLength;
  expect(a.run(-6)).toBe(0);
  expect(memory.buffer.byteLength).toBe(before + 65536);
  expect(new TextDecoder().decode(textBytes(cores[0]!))).toBe("GROWN");
  expect(a.run(-10)).toBe(0);
  expect(textBytes(cores[0]!)).toHaveLength(4096);
  a.close();
  expect(native(cores[0]!, "lv_is_initialized")).toBe(0);
  expect(native(cores[1]!, "lv_is_initialized")).toBe(1);
  expect(() => a.readFrame()).toThrow();
  expect(b.run(-1)).toBe(0);
  b.close();
  expect(native(cores[1]!, "lv_is_initialized")).toBe(0);
});

test("failed application init rolls back the actual core", async () => {
  const { cores } = contexts.getStore()!;
  const { input, options } = await fixture(true);
  await expect(load(input, options)).rejects.toThrow("module_init returned 7");
  expect(cores).toHaveLength(1);
  expect(native(cores[0]!, "lv_is_initialized")).toBe(0);
});

for (const [name, value, error] of [
  ["out-of-bounds pointer", -2, "LVGL text pointer is out of bounds"],
  ["unterminated string", -5, "LVGL text is unterminated or too long"],
  ["oversized string", -7, "LVGL text is unterminated or too long"],
  ["wrong object kind", -8, "invalid LVGL label handle"],
  ["null parent", -11, "invalid LVGL label handle"],
  ["forged handle", 0x7fffffff, "invalid LVGL label handle"],
] as const) {
  test(`${name} rejects and poisons the environment`, async () => {
    const { input, options } = await fixture();
    const environment = await load(input, options);
    expect(() => environment.run(value)).toThrow(error);
    expect(environment.state).toBe("poisoned");
    expect(() => environment.run(-1)).toThrow(error);
    expect(() => environment.close()).toThrow(error);
  });
}

test("label quota rejects creation past the configured limit", async () => {
  const { input, options } = await fixture();
  const environment = await load(input, options);
  for (let i = 0; i < 7; i++) expect(environment.run(-9)).toBe(0);
  expect(() => environment.run(-9)).toThrow("LVGL label quota exceeded");
  expect(environment.state).toBe("poisoned");
});

test("foreign and stale tokens do not address labels in another environment", async () => {
  const { input, options } = await fixture();
  const a = await load(input, options), b = await load(input, options);
  const token = a.run(0);
  expect(token).not.toBe(b.run(0));
  expect(() => b.run(token)).toThrow("invalid LVGL label handle");
  expect(b.state).toBe("poisoned");
  a.close();
  const c = await load(input, options);
  expect(() => c.run(token)).toThrow("invalid LVGL label handle");
  expect(c.state).toBe("poisoned");
});
