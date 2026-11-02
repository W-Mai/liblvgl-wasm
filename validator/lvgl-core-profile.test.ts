import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, test as bunTest } from "bun:test";
import { inspectWasmFacts, type WasmFacts } from "../bindings/typescript/src/wasm-facts.ts";

type Capture = { instance: WebAssembly.Instance; imports: WebAssembly.Imports };
type Operation = { controller: AbortController; promise: ReturnType<typeof loadNumericEnvironment> };
type Environment = Awaited<ReturnType<typeof loadNumericEnvironment>>;
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
const Instance = WebAssembly.Instance;
const proxy = new Proxy(Instance, {
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
  ({ loadNumericEnvironment } = await import("../target/validator/feature-validator.js?lvgl-core-profile-test"));
} finally {
  Object.defineProperty(WebAssembly, "Instance", instanceProperty);
}

function load(input: Parameters<typeof loadNumericEnvironment>[0], options: Parameters<typeof loadNumericEnvironment>[1]) {
  const context = contexts.getStore()!;
  if (context.ending) return Promise.reject(new Error("test cleanup in progress"));
  const controller = new AbortController();
  const promise = loadNumericEnvironment(input, { ...options, signal: controller.signal });
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
      timer = setTimeout(() => reject(new Error("LVGL profile test cleanup timed out")), 10_000);
    })]);
  } catch (error) { context.errors.push(error); } finally { clearTimeout(timer); }
  for (const environment of context.environments) {
    if (environment.state !== "ready") continue;
    try { environment.close(); } catch (error) { context.errors.push(error); }
  }
  context.environments.clear();
  if (context.errors.length) throw new AggregateError(context.errors, "LVGL profile test cleanup failed");
}, 30_000);

const features = ["bulk-memory", "reference-types", "sign-extension", "saturating-float-to-int", "exceptions"];
const iface = (name: string) => ({ name, version: 1 });
const initialized = (capture: Capture) => (capture.instance.exports.lv_is_initialized as () => number)();
const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

function checkCoreIdentity(coreBytes: Uint8Array, apiBytes: Uint8Array, proofBytes: Uint8Array) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const api = JSON.parse(decoder.decode(apiBytes));
  const proof = JSON.parse(decoder.decode(proofBytes));
  if (api === null || typeof api !== "object" || api.schema_version !== 1 || !Array.isArray(api.declarations)
      || api.wasm_summary === null || typeof api.wasm_summary !== "object") throw new Error("invalid bounded core API metadata");
  const exports = new Set<string>();
  for (const declaration of api.declarations) {
    if (declaration === null || typeof declaration !== "object") throw new Error("invalid bounded core API declaration");
    if (declaration.category === "compile_disabled" || declaration.category === "unsupported") continue;
    if ((declaration.category !== "direct_export" && declaration.category !== "abi_shim")
        || typeof declaration.export_name !== "string" || !declaration.export_name || exports.has(declaration.export_name)) {
      throw new Error("invalid bounded core API inventory");
    }
    exports.add(declaration.export_name);
  }
  const keys = ["schema_version", "api_sha256", "wasm_sha256", "expected_functions", "verified_functions"];
  if (proof === null || typeof proof !== "object" || Array.isArray(proof)
      || Object.keys(proof).length !== keys.length || Object.keys(proof).some((key) => !keys.includes(key))
      || proof.schema_version !== 1 || proof.api_sha256 !== sha256(apiBytes) || proof.wasm_sha256 !== sha256(coreBytes)
      || !Number.isSafeInteger(proof.expected_functions) || proof.expected_functions <= 0
      || proof.expected_functions !== proof.verified_functions || proof.expected_functions !== api.wasm_summary.expected_functions
      || proof.expected_functions !== exports.size) throw new Error("bounded core proof does not match its inputs");
}

async function coreSnapshot(proofPath = "target/wasm/api-verification-bounded.json") {
  const core = Bun.file("target/wasm/liblvgl-bounded.wasm"), api = Bun.file("target/wasm/api.json"), proof = Bun.file(proofPath);
  if (!await proof.exists()) throw new Error("bounded core proof is missing");
  if (core.size > 64 * 1024 * 1024 || api.size > 32 * 1024 * 1024 || proof.size > 1024 * 1024) throw new Error("bounded core input is too large");
  const [coreBytes, apiBytes, proofBytes] = await Promise.all([core.bytes(), api.bytes(), proof.bytes()]);
  if (coreBytes.length > 64 * 1024 * 1024 || apiBytes.length > 32 * 1024 * 1024 || proofBytes.length > 1024 * 1024) throw new Error("bounded core input is too large");
  checkCoreIdentity(coreBytes, apiBytes, proofBytes);
  return { coreBytes, apiBytes, proofBytes };
}

function descriptor(facts: WasmFacts, item: WasmFacts["exports"][number] | WasmFacts["imports"][number]) {
  if (item.kind === "function" || item.kind === "tag") return { name: item.name, kind: item.kind, ...facts.types[item.typeIndex]! };
  return { name: item.name, kind: item.kind, ...item.type };
}

async function fixture(failInit = false) {
  const { coreBytes } = await coreSnapshot();
  const appBytes = await Bun.file(`target/validator/lvgl-core-app${failInit ? "-fail-init" : ""}.wasm`).bytes();
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
  const wasiImports = imports(core, "wasi_snapshot_preview1"), lvwImports = imports(core, "lvw"), appImports = imports(app, "lvcore");
  expect(wasiImports).toHaveLength(7);
  expect(lvwImports).toHaveLength(14);
  expect(appImports.map((item) => item.name)).toEqual(["lv_is_initialized"]);
  const memories = [...core.memories, ...app.memories].map((item) => item.type.maximumPages);
  const tables = [...core.tables, ...app.tables].map((item) => item.type.maximum);
  if (memories.some((value) => value === null) || tables.some((value) => value === null)) throw new Error("fixture resources must be bounded");
  expect(core.tables[0]!.type.maximum).toBe(core.tables[0]!.type.minimum);
  const wasiExports = wasiImports.map((item) => descriptor(core, item));
  const lvwExports = lvwImports.map((item) => descriptor(core, item));
  const modules = [
    { manifest: manifest("app", "app", app, [], [requirement("lvcore", "lvcore", app, appImports)]), bytes: appBytes },
    { manifest: manifest("lvcore", "lib", core, features, [requirement("host.wasi", "wasi", core, wasiImports), requirement("host.lvw", "lvw", core, lvwImports)]), bytes: coreBytes },
  ];
  const input = { modules, hosts: [{ id: "host.wasi", interface: iface("wasi"), exports: wasiExports },
    { id: "host.lvw", interface: iface("lvw"), exports: lvwExports }] };
  const options = { profile: "lvgl-core-v1", lvgl: { module: "lvcore", id: "host.lvw", interface: iface("lvw"), abiVersion: 1 },
    modules: [{ id: "app", sha256: app.sha256, interface: iface("app"), exports: [] },
      { id: "lvcore", sha256: core.sha256, interface: iface("lvcore"), exports: [{ name: "lv_is_initialized", params: [], results: ["i32"] }] }],
    hosts: [], wasi: { id: "host.wasi", interface: iface("wasi"), allowed: wasiExports.map((item) => item.name), outputFds: [],
      maxIovecs: 16, maxWriteBytes: 4096, maxOutputBytes: 4096, clock: { realtimeNs: 0n, monotonicNs: 0n },
      onWrite: () => { throw new Error("unexpected WASI output"); } },
    allowedFeatures: features, startupTimeoutMs: 30_000, executionTimeoutMs: 30_000,
    maxMemoryPages: Math.max(...memories as number[]), maxTotalMemoryPages: (memories as number[]).reduce((sum, value) => sum + value, 0),
    maxTableElements: Math.max(...tables as number[]), maxTotalTableElements: (tables as number[]).reduce((sum, value) => sum + value, 0) };
  return { input, options };
}

test("the fixed-table core requires a matching API and signature proof", async () => {
  const { coreBytes, apiBytes, proofBytes } = await coreSnapshot();
  const proof = JSON.parse(new TextDecoder().decode(proofBytes));
  proof.wasm_sha256 = "0".repeat(64);
  expect(() => checkCoreIdentity(coreBytes, apiBytes, new TextEncoder().encode(JSON.stringify(proof)))).toThrow("bounded core proof does not match");
  const forged = JSON.parse(new TextDecoder().decode(proofBytes));
  forged.expected_functions = forged.verified_functions = 1;
  expect(() => checkCoreIdentity(coreBytes, apiBytes, new TextEncoder().encode(JSON.stringify(forged)))).toThrow("bounded core proof does not match");
  const altered = coreBytes.slice();
  altered[altered.length - 1] ^= 1;
  expect(() => checkCoreIdentity(altered, apiBytes, proofBytes)).toThrow("bounded core proof does not match");
  await expect(coreSnapshot(`target/wasm/missing-bounded-proof-${crypto.randomUUID()}.json`)).rejects.toThrow("bounded core proof is missing");
});

test("the core and C app initialize and close independently in two environments", async () => {
  const { cores, apps } = contexts.getStore()!;
  const { input, options } = await fixture();
  let a: Awaited<ReturnType<typeof loadNumericEnvironment>> | undefined;
  let b: Awaited<ReturnType<typeof loadNumericEnvironment>> | undefined;
  try {
    a = await load(input as any, options as any);
    b = await load(input as any, options as any);
    expect(Object.keys(a).sort()).toEqual(["close", "run", "state"]);
    expect(cores).toHaveLength(2);
    expect(apps).toHaveLength(2);
    const memories = [...cores, ...apps].map(({ instance }) => instance.exports.memory);
    expect(memories.every((memory) => memory instanceof WebAssembly.Memory)).toBe(true);
    expect(new Set(memories).size).toBe(4);
    expect(initialized(cores[0]!)).toBe(1);
    expect(initialized(cores[1]!)).toBe(1);
    expect(a.run(5)).toBe(5);
    expect(b.run(9)).toBe(9);
    a.close();
    expect(a.state).toBe("closed");
    expect(initialized(cores[0]!)).toBe(0);
    expect(initialized(cores[1]!)).toBe(1);
    expect(b.run(7)).toBe(7);
    b.close();
    expect(b.state).toBe("closed");
    expect(initialized(cores[1]!)).toBe(0);
  } finally {
    if (a?.state === "ready") a.close();
    if (b?.state === "ready") b.close();
  }
});

test("a failed C app initialization shuts down its initialized core", async () => {
  const { cores, apps } = contexts.getStore()!;
  const { input, options } = await fixture(true);
  await expect(load(input as any, options as any)).rejects.toThrow("module_init returned 7");
  expect(cores).toHaveLength(1);
  expect(apps).toHaveLength(1);
  expect(initialized(cores[0]!)).toBe(0);
});

for (const name of ["event", "timer", "timer_release", "anim_exec", "anim_query", "anim_notify", "anim_release",
  "observer", "observer_release", "decoder_info", "decoder_open", "decoder_area", "decoder_close", "decoder_release"]) {
  test(`unexpected LVGL ${name} callback poisons the environment`, async () => {
    const { cores } = contexts.getStore()!;
    const { input, options } = await fixture();
    const environment = await load(input as any, options as any);
    try {
      expect(cores).toHaveLength(1);
      const lvw = cores[0]!.imports.lvw as Record<string, (...args: number[]) => unknown>;
      let failure: unknown;
      try { lvw[name]!(0, 0, 0, 0, 0); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain(`unsupported LVGL callback ${JSON.stringify(name)}`);
      expect(environment.state).toBe("poisoned");
      expect(() => environment.run(1)).toThrow(failure as Error);
      expect(() => environment.close()).toThrow(failure as Error);
    } finally {
      if (environment.state === "ready") environment.close();
    }
  });
}
