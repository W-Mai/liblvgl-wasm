import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, test as bunTest } from "bun:test";
import { inspectWasmFacts } from "../bindings/typescript/src/wasm-facts.ts";
import { loadNumericEnvironment as loadEnvironment } from "../target/validator/feature-validator.js";

type Operation = { controller: AbortController; promise: ReturnType<typeof loadEnvironment> };
type Environment = Awaited<ReturnType<typeof loadEnvironment>>;
type Context = { ending: boolean; active: Set<Operation>; environments: Set<Environment>; cleanupErrors: unknown[] };
const contexts = new AsyncLocalStorage<Context>();
let current: Context;
const test = (name: string, body: () => void | Promise<void>, timeout: number) => bunTest(name, () => {
  const context: Context = { ending: false, active: new Set(), environments: new Set(), cleanupErrors: [] };
  current = context;
  return contexts.run(context, () => Promise.resolve().then(body)).catch((error: unknown) => { if (!context.ending) throw error; });
}, timeout);

function loadNumericEnvironment(input: Parameters<typeof loadEnvironment>[0], options: Parameters<typeof loadEnvironment>[1]) {
  const context = contexts.getStore()!;
  if (context.ending) return Promise.reject(new Error("test cleanup in progress"));
  const controller = new AbortController();
  const promise = loadEnvironment(input, { ...options, signal: controller.signal });
  const operation = { controller, promise };
  context.active.add(operation);
  const release = () => context.active.delete(operation);
  promise.then((environment) => {
    if (context.ending && environment.state === "ready") {
      try { environment.close(); } catch (error) { context.cleanupErrors.push(error); }
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
  const errors: unknown[] = [];
  try {
    await Promise.race([Promise.allSettled(pending.map(({ promise }) => promise)), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("LVGL test cleanup timed out")), 10_000);
    })]);
  } catch (error) { errors.push(error); } finally { clearTimeout(timer); }
  for (const environment of context.environments) {
    if (environment.state !== "ready") continue;
    try { environment.close(); } catch (error) { errors.push(error); }
  }
  context.environments.clear();
  errors.push(...context.cleanupErrors);
  if (errors.length) throw new AggregateError(errors, "LVGL test cleanup failed");
}, 30_000);

const fn = (name: string, params: string[], results: string[]) => ({ name, kind: "function", params, results });
const trace = fn("event", ["i32"], []);
const ping = fn("ping", [], ["i32"]);
const tick = fn("lv_tick_get", [], ["i32"]);

async function fixture(coreVariant = "core", appVariant = "app", baseVariant = "base") {
  const names = { base: baseVariant, lvcore: coreVariant, app: appVariant };
  const records = await Promise.all(Object.entries(names).map(async ([id, file]) => {
    const bytes = await Bun.file(`target/validator/lvgl-lifecycle/${file}.wasm`).bytes();
    return { id, bytes, facts: inspectWasmFacts(bytes) };
  }));
  const byId = (id: string) => records.find((record) => record.id === id)!;
  const toFunction = (facts: ReturnType<typeof inspectWasmFacts>, entry: { name: string; kind: string; typeIndex?: number }) => {
    if (entry.kind !== "function" || entry.typeIndex === undefined) throw new Error("expected function fixture");
    const signature = facts.types[entry.typeIndex]!;
    return fn(entry.name, [...signature.params], [...signature.results]);
  };
  const imported = (id: string, namespace: string) => {
    const record = byId(id);
    return record.facts.imports.filter((item) => item.module === namespace).map((item) => ({
      ...toFunction(record.facts, item), module: item.module, provider_export: item.name,
    }));
  };
  const coreNamespace = coreVariant === "core-alias-event" ? "not-lvw" : "lvw";
  const requires = (id: string) => id === "base" ? [
    { provider: "host.trace", interface: "trace", version: 1, imports: imported(id, "trace") },
  ] : id === "lvcore" ? [
    { provider: "host.trace", interface: "trace", version: 1, imports: imported(id, "trace") },
    { provider: "base", interface: "base", version: 1, imports: imported(id, "base") },
    { provider: "host.lvw", interface: "lvw", version: 1, imports: imported(id, coreNamespace) },
  ] : [
    { provider: "host.trace", interface: "trace", version: 1, imports: imported(id, "trace") },
    { provider: "lvcore", interface: "lvcore", version: 1, imports: imported(id, "core") },
    ...(appVariant === "app-steal" ? [{ provider: "host.lvw", interface: "lvw", version: 1, imports: imported(id, "lvw") }] : []),
  ];
  const modules = records.map(({ id, bytes, facts }) => ({ bytes, manifest: {
    schema_version: 1, kind: "wasm-module", id, role: id === "app" ? "app" : "lib",
    artifact: { path: `${id}.wasm`, sha256: facts.sha256 }, target: { abi: "wasip1", features: [] },
    interface: { name: id, version: 1 }, memory_model: "isolated", runtime_verification: "not-run",
    requires: requires(id), exports: facts.exports.map((item) => toFunction(facts, item)),
  } }));
  const lvwExports = imported("lvcore", coreNamespace).map(({ name, kind, params, results }) => ({ name, kind, params, results }));
  const input: any = { modules, hosts: [
    { id: "host.trace", interface: { name: "trace", version: 1 }, exports: [trace] },
    { id: "host.lvw", interface: { name: "lvw", version: 1 }, exports: lvwExports },
  ] };
  const numeric = ({ name, params, results }: typeof tick) => ({ name, params: [...params], results: [...results] });
  const events: (number | string)[] = [];
  let factories = 0;
  const options: any = { profile: "lvgl-core-v1", lvgl: { module: "lvcore", id: "host.lvw",
    interface: { name: "lvw", version: 1 }, abiVersion: 1 },
    modules: modules.map(({ manifest }) => ({ id: manifest.id, sha256: manifest.artifact.sha256, interface: manifest.interface,
      exports: manifest.id === "base" ? [numeric(ping)] : manifest.id === "lvcore" ? [numeric(tick)] : [] })),
    hosts: [{ id: "host.trace", interface: { name: "trace", version: 1 }, exports: [numeric(trace)],
      create: (consumer: string) => { factories++; return { exports: { event: (value: number) => { events.push(value); } },
        close: () => { events.push(`host:${consumer}`); } }; } }],
    allowedFeatures: [], startupTimeoutMs: 30_000, executionTimeoutMs: 30_000,
    maxMemoryPages: 2, maxTotalMemoryPages: 6, maxTableElements: 0, maxTotalTableElements: 0 };
  return { input, options, events, factoryCount: () => factories };
}

const traceEvents = (events: (number | string)[]) => events.filter((value) => typeof value === "number");

test("LVGL core uses its owned lifecycle between dependent modules", async () => {
  const { input, options, events } = await fixture();
  const environment = await loadNumericEnvironment(input, options);
  expect(traceEvents(events)).toEqual([10, 11, 20, 21, 22, 30, 31]);
  expect(environment.run(5)).toBe(7);
  environment.close();
  expect(environment.state).toBe("closed");
  expect(traceEvents(events)).toEqual([10, 11, 20, 21, 22, 30, 31, 32, 39, 29, 19]);
}, 300_000);

for (const [variant, message, expected] of [
  ["core-bad-abi", "unsupported LVGL bridge ABI", [10, 11, 20, 21, 19]],
  ["core-init-fail", "lvw_init returned 7", [10, 11, 20, 21, 22, 19]],
  ["core-init-trap", null, [10, 11, 20, 21, 22]],
  ["core-reactor-trap", null, [10, 11, 20]],
  ["core-event-init", "unsupported LVGL callback", [10, 11, 20, 21, 22]],
] as const) {
  test(`${variant} preserves rollback and poison boundaries`, async () => {
    const { input, options, events } = await fixture(variant);
    const pending = loadNumericEnvironment(input, options);
    if (message === null) await expect(pending).rejects.toBeInstanceOf(WebAssembly.RuntimeError);
    else await expect(pending).rejects.toThrow(message);
    expect(traceEvents(events)).toEqual(expected);
    expect(events.filter((value) => typeof value === "string").sort()).toEqual(["host:app", "host:base", "host:lvcore"]);
  }, 300_000);
}

test("failed app init rolls back the initialized real-profile provider", async () => {
  const { input, options, events } = await fixture("core", "app-fail");
  await expect(loadNumericEnvironment(input, options)).rejects.toThrow("module_init returned 8");
  expect(traceEvents(events)).toEqual([10, 11, 20, 21, 22, 30, 31, 29, 19]);
}, 300_000);

for (const [variant, message, expected] of [
  ["core-bad-abi", "unsupported LVGL bridge ABI", [10, 11, 20, 21, 19]],
  ["core-init-fail", "lvw_init returned 7", [10, 11, 20, 21, 22, 19]],
] as const) {
  test(`${variant} preserves its failure when an earlier provider traps during rollback`, async () => {
    const { input, options, events } = await fixture(variant, "app", "base-close-trap");
    let failure: unknown;
    try { await loadNumericEnvironment(input, options); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    const errors = (failure as AggregateError).errors;
    expect(String(errors[0])).toContain(message);
    expect(errors[1]).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(traceEvents(events)).toEqual(expected);
  }, 300_000);
}

test("a swallowed reentrant call still poisons the LVGL environment", async () => {
  const { input, options, events } = await fixture();
  let environment: Environment;
  const create = options.hosts[0].create;
  options.hosts[0].create = (consumer: string, id: symbol) => {
    const host = create(consumer, id), event = host.exports.event;
    host.exports.event = (value: number) => {
      event(value);
      if (value === 32) { try { environment.close(); } catch { /* The outer call must retain the failure. */ } }
    };
    return host;
  };
  environment = await loadNumericEnvironment(input, options);
  expect(() => environment.run(5)).toThrow("not reentrant");
  expect(environment.state).toBe("poisoned");
  expect(traceEvents(events)).toEqual([10, 11, 20, 21, 22, 30, 31, 32]);
  expect(() => environment.close()).toThrow("not reentrant");
}, 300_000);

for (const [variant, operation, message, expected] of [
  ["core-run-trap", "run", null, [10, 11, 20, 21, 22, 30, 31, 32]],
  ["core-event-run", "run", "unsupported LVGL callback", [10, 11, 20, 21, 22, 30, 31, 32]],
  ["core-close-trap", "close", null, [10, 11, 20, 21, 22, 30, 31, 39, 29]],
  ["core-close-fail", "close", "lvw_shutdown returned 7", [10, 11, 20, 21, 22, 30, 31, 39, 29]],
] as const) {
  test(`${variant} poisons the whole environment without later guest calls`, async () => {
    const { input, options, events } = await fixture(variant);
    const environment = await loadNumericEnvironment(input, options);
    const invoke = () => operation === "run" ? environment.run(5) : environment.close();
    if (message === null) expect(invoke).toThrow(WebAssembly.RuntimeError);
    else expect(invoke).toThrow(message);
    expect(environment.state).toBe("poisoned");
    expect(() => environment.run(5)).toThrow();
    expect(() => environment.close()).toThrow();
    expect(traceEvents(events)).toEqual(expected);
    expect(events.filter((value) => typeof value === "string").sort()).toEqual(["host:app", "host:base", "host:lvcore"]);
  }, 300_000);
}

for (const [label, core, app, message, mutate] of [
  ["wrong identity", "core", "app", "not authorized", (f: any) => { f.options.modules.find((m: any) => m.id === "lvcore").sha256 = "0".repeat(64); }],
  ["wrong interface", "core", "app", "LVGL host contract differs", (f: any) => { f.options.lvgl.interface.version = 2; }],
  ["forged host factory", "core", "app", "identity conflicts", (f: any) => { f.options.hosts.push({ id: "host.lvw", interface: { name: "lvw", version: 1 }, exports: [], create: () => { throw new Error("must not create"); } }); }],
  ["bad callback signature", "core-bad-event", "app", "LVGL host contract differs", (_f: any) => {}],
  ["aliased callback namespace", "core-alias-event", "app", "LVGL host import is not authorized", (_f: any) => {}],
  ["app calling the built-in bridge", "core", "app-steal", "LVGL host is reserved for its core", (_f: any) => {}],
  ["pointer-like core export", "core", "app", "unsupported LVGL scalar export", (f: any) => { f.options.modules.find((m: any) => m.id === "lvcore").exports.push({ name: "lv_obj_create", params: ["i32"], results: ["i32"] }); }],
  ["reserved lifecycle export", "core", "app-reserved", "LVGL lifecycle exports cannot be authorized", (f: any) => { f.options.modules.find((m: any) => m.id === "lvcore").exports.push({ name: "lvw_init", params: [], results: ["i32"] }); }],
  ["missing lifecycle export", "core-missing-init", "app", "missing lvw_init", (_f: any) => {}],
  ["imported lifecycle export", "core-imported-init", "app", "lvw_init must be an owned function", (_f: any) => {}],
  ["bad lifecycle signature", "core-bad-abi-signature", "app", "invalid lvw_abi_version signature", (_f: any) => {}],
] as const) {
  test(`${label} is rejected before any host or guest side effect`, async () => {
    const f = await fixture(core, app);
    mutate(f);
    await expect(loadNumericEnvironment(f.input, f.options)).rejects.toThrow(message);
    expect(f.factoryCount()).toBe(0);
    expect(f.events).toEqual([]);
  }, 300_000);
}
