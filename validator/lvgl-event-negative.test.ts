import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, test as bunTest } from "bun:test";
import { inspectWasmFacts } from "../bindings/typescript/src/wasm-facts.ts";
import { loadNumericEnvironment as loadEnvironment } from "../target/validator/feature-validator.js";

type Environment = Awaited<ReturnType<typeof loadEnvironment>>;
type Operation = { controller: AbortController; promise: ReturnType<typeof loadEnvironment> };
type Context = { ending: boolean; active: Set<Operation>; environments: Set<Environment>; errors: unknown[] };
const contexts = new AsyncLocalStorage<Context>();
let current: Context;
const test = (name: string, body: () => void | Promise<void>) => bunTest(name, () => {
  const context: Context = { ending: false, active: new Set(), environments: new Set(), errors: [] };
  current = context;
  return contexts.run(context, () => Promise.resolve().then(body)).catch((error: unknown) => { if (!context.ending) throw error; });
}, 300_000);

function load(input: Parameters<typeof loadEnvironment>[0], options: Parameters<typeof loadEnvironment>[1]) {
  const context = contexts.getStore()!;
  if (context.ending) return Promise.reject(new Error("test cleanup in progress"));
  const controller = new AbortController();
  const promise = loadEnvironment(input, { ...options, signal: controller.signal });
  const operation = { controller, promise };
  context.active.add(operation);
  const release = () => context.active.delete(operation);
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
      timer = setTimeout(() => reject(new Error("event test cleanup timed out")), 10_000);
    })]);
  } catch (error) { context.errors.push(error); } finally { clearTimeout(timer); }
  for (const environment of context.environments) {
    if (environment.state !== "ready") continue;
    try { environment.close(); } catch (error) { context.errors.push(error); }
  }
  context.environments.clear();
  if (context.errors.length) throw new AggregateError(context.errors, "event test cleanup failed");
}, 30_000);

async function fixture(coreVariant = "core", appVariant = "app", dependency = true) {
  const records = await Promise.all([["lvcore", coreVariant], ["app", appVariant]].map(async ([id, name]) => {
    const bytes = await Bun.file(`target/validator/lvgl-event-negative/${name}.wasm`).bytes();
    return { id: id!, bytes, facts: inspectWasmFacts(bytes) };
  }));
  const core = records[0]!, app = records[1]!;
  const signature = (facts: typeof core.facts, item: (typeof core.facts.imports)[number] | (typeof core.facts.exports)[number]) => {
    if (item.kind === "function" || item.kind === "tag") return { name: item.name, kind: item.kind, ...facts.types[item.typeIndex]! };
    return { name: item.name, kind: item.kind, ...item.type };
  };
  const imports = (record: typeof core, namespace: string) => record.facts.imports.filter((item) => item.module === namespace)
    .map((item) => ({ ...signature(record.facts, item), module: item.module, provider_export: item.name }));
  const eventNamespace = appVariant === "app-alias" ? "not-lvgl" : "lvgl";
  const coreLvgl = imports(core, "lvgl"), appLvgl = imports(app, eventNamespace), lvw = imports(core, "lvw");
  const requirement = (provider: string, interfaceName: string, items: object[]) => ({ provider, interface: interfaceName, version: 1, imports: items });
  const exports = (items: typeof appLvgl) => items.map(({ name, kind, ...item }) => {
    const { module: _module, provider_export: _provider, ...type } = item;
    return { name, kind, ...type };
  });
  const coreRequires = [requirement("host.trace", "trace", imports(core, "trace")), requirement("host.lvw", "lvw", lvw),
    ...(coreLvgl.length ? [requirement("host.label", "lvgl", coreLvgl)] : [])];
  const appRequires = [requirement("host.trace", "trace", imports(app, "trace")), requirement("host.label", "lvgl", appLvgl),
    ...(dependency ? [requirement("lvcore", "lvcore", [])] : [])];
  const iface = (name: string) => ({ name, version: 1 });
  const modules = records.map(({ id, bytes, facts }) => ({ bytes, manifest: {
    schema_version: 1, kind: "wasm-module", id, role: id === "app" ? "app" : "lib",
    artifact: { path: `${id}.wasm`, sha256: facts.sha256 }, target: { abi: "wasip1", features: [] },
    interface: iface(id), memory_model: "isolated", runtime_verification: "not-run",
    requires: id === "app" ? appRequires : coreRequires, exports: facts.exports.map((item) => signature(facts, item)),
  } }));
  const trace = { name: "event", kind: "function", params: ["i32"], results: [] };
  const dispatch = { name: "dispatch", kind: "function", params: ["i32", "i32"], results: [] };
  const traceExports = appVariant === "app-imported-dispatch" ? [trace, dispatch] : [trace];
  const input: any = { modules, hosts: [{ id: "host.trace", interface: iface("trace"), exports: traceExports },
    { id: "host.lvw", interface: iface("lvw"), exports: exports(lvw) },
    { id: "host.label", interface: iface("lvgl"), exports: exports(appLvgl) }] };
  const events: (number | string)[] = [];
  let factories = 0;
  const options: any = { profile: "lvgl-event-v1", lvgl: { module: "lvcore", id: "host.lvw", interface: iface("lvw"), abiVersion: 1 },
    label: { id: "host.label", interface: iface("lvgl"), width: 8, height: 8, maxLabels: 4, maxTextBytes: 16 },
    event: { maxRegistrations: 1, maxDepth: 4 },
    modules: modules.map(({ manifest }) => ({ id: manifest.id, sha256: manifest.artifact.sha256, interface: manifest.interface, exports: [] })),
    hosts: [{ id: "host.trace", interface: iface("trace"), exports: traceExports.map(({ name, params, results }) => ({ name, params, results })),
      create: (consumer: string) => { factories++; return { exports: appVariant === "app-imported-dispatch"
        ? { event: (value: number) => { events.push(value); }, dispatch: () => {} }
        : { event: (value: number) => { events.push(value); } }, close: () => { events.push(`host:${consumer}`); } }; } }],
    allowedFeatures: [], startupTimeoutMs: 30_000, executionTimeoutMs: 30_000,
    maxMemoryPages: 2, maxTotalMemoryPages: 4, maxTableElements: 4, maxTotalTableElements: 4 };
  return { input, options, events, factories: () => factories };
}

const guestTrace = (values: (number | string)[]) => values.filter((value) => typeof value === "number");

test("typed app-local callbacks nest synchronously and close before core shutdown", async () => {
  const { input, options, events } = await fixture();
  const environment = await load(input, options);
  expect(environment.run(1)).toBe(2);
  expect(guestTrace(events).filter((item) => item === 70 || item === 71)).toEqual([70, 70, 71, 71]);
  environment.close();
  const trace = guestTrace(events);
  expect(trace.indexOf(39)).toBeLessThan(trace.indexOf(51));
  expect(trace.indexOf(51)).toBeLessThan(trace.indexOf(19));
});

test("removing the active registration preserves its frame but prevents later callbacks", async () => {
  const { input, options, events } = await fixture();
  const environment = await load(input, options);
  expect(environment.run(4)).toBe(1);
  expect(environment.run(2)).toBe(1);
  expect(guestTrace(events).filter((item) => item === 70 || item === 71)).toEqual([70, 71]);
  environment.close();
  expect(guestTrace(events).filter((item) => item === 51)).toHaveLength(1);
});

test("nested sends to another label restore the outer target", async () => {
  const { input, options, events } = await fixture("core", "app-multilabel");
  options.event.maxRegistrations = 2;
  const environment = await load(input, options);
  expect(environment.run(11)).toBe(2);
  expect(guestTrace(events).filter((item) => item === 70 || item === 71)).toEqual([70, 70, 71, 71]);
  environment.close();
  expect(guestTrace(events).filter((item) => item === 51)).toHaveLength(2);
});

test("a direct send cannot dispatch a different registered target", async () => {
  const { input, options, events } = await fixture("core-cross-send", "app-multilabel");
  options.event.maxRegistrations = 2;
  const environment = await load(input, options);
  expect(() => environment.run(10)).toThrow();
  expect(environment.state).toBe("poisoned");
  expect(guestTrace(events)).not.toContain(70);
  expect(guestTrace(events)).not.toContain(51);
  expect(guestTrace(events)).not.toContain(19);
});

for (const [name, core, app, action] of [
  ["stale borrowed event", "core", "app", 3], ["non-click event", "core", "app", 5],
  ["non-NULL event parameter", "core", "app", 6], ["registration quota", "core", "app", 7],
  ["wrong target kind", "core", "app", 8], ["wrong descriptor kind", "core", "app", 9],
  ["unexpected callback ID", "core-bad-id", "app", 2], ["unexpected current target", "core-bad-current", "app", 2],
  ["unexpected callback code", "core-bad-code", "app", 2], ["NULL borrowed core event", "core-event-null", "app", 2],
  ["unexpected original target", "core-original-mismatch", "app", 2], ["wrong callback signature", "core", "app-wrong-index", 2],
  ["empty callback table slot", "core", "app-empty-index", 2], ["app callback trap", "core", "app-callback-trap", 2],
] as const) {
  test(`${name} poisons without further guest cleanup`, async () => {
    const { input, options, events } = await fixture(core, app);
    const environment = await load(input, options);
    if (action === 3) expect(environment.run(2)).toBe(1);
    expect(() => environment.run(action)).toThrow();
    expect(environment.state).toBe("poisoned");
    expect(guestTrace(events)).not.toContain(51);
    expect(guestTrace(events)).not.toContain(19);
    expect(() => environment.close()).toThrow();
  });
}

test("a nested event exceeding its configured depth poisons without shutdown", async () => {
  const { input, options, events } = await fixture();
  options.event.maxDepth = 1;
  const environment = await load(input, options);
  expect(() => environment.run(1)).toThrow();
  expect(environment.state).toBe("poisoned");
  expect(guestTrace(events)).toContain(70);
  expect(guestTrace(events)).not.toContain(51);
  expect(guestTrace(events)).not.toContain(19);
});

test("a swallowed reentrant call inside a callback still poisons the graph", async () => {
  const { input, options, events } = await fixture();
  let environment: Environment;
  const create = options.hosts[0].create;
  options.hosts[0].create = (consumer: string, id: symbol) => {
    const host = create(consumer, id), event = host.exports.event;
    host.exports.event = (value: number) => {
      event(value);
      if (value === 70) { try { environment.close(); } catch { /* The outer call must retain the failure. */ } }
    };
    return host;
  };
  environment = await load(input, options);
  expect(() => environment.run(2)).toThrow("not reentrant");
  expect(environment.state).toBe("poisoned");
  expect(guestTrace(events)).not.toContain(51);
  expect(guestTrace(events)).not.toContain(19);
});

test("native registration failure returns NULL and rolls back without unregistering", async () => {
  const { input, options, events } = await fixture("core-add-fail");
  await expect(load(input, options)).rejects.toThrow("module_init returned 9");
  expect(guestTrace(events)).toContain(50);
  expect(guestTrace(events)).not.toContain(51);
  expect(guestTrace(events)).toContain(19);
});

test("a NULL callback index returns NULL without registering or poisoning", async () => {
  const { input, options, events } = await fixture("core", "app-null-index");
  await expect(load(input, options)).rejects.toThrow("module_init returned 9");
  expect(guestTrace(events)).not.toContain(50);
  expect(guestTrace(events)).not.toContain(51);
  expect(guestTrace(events)).toContain(19);
});

for (const [core, app] of [["core-add-error", "app"], ["core-add-trap", "app"], ["core", "app-wrong-code"]] as const) {
  test(`${core}/${app} rejects registration without guest cleanup`, async () => {
    const { input, options, events } = await fixture(core, app);
    await expect(load(input, options)).rejects.toThrow();
    if (app === "app-wrong-code") expect(guestTrace(events)).not.toContain(50);
    else expect(guestTrace(events)).toContain(50);
    expect(guestTrace(events)).not.toContain(51);
    expect(guestTrace(events)).not.toContain(19);
  });
}

for (const variant of ["app-close-fail", "app-close-trap"] as const) {
  test(`${variant} poisons without unregistering or shutting down core`, async () => {
    const { input, options, events } = await fixture("core", variant);
    const environment = await load(input, options);
    expect(() => environment.close()).toThrow();
    expect(environment.state).toBe("poisoned");
    expect(guestTrace(events)).toContain(39);
    expect(guestTrace(events)).not.toContain(51);
    expect(guestTrace(events)).not.toContain(19);
  });
}

for (const [variant, init] of [["core-remove-fail", true], ["core-remove-trap", true],
  ["core-remove-fail", false], ["core-remove-trap", false]] as const) {
  test(`${variant} preserves failure and stops shutdown during ${init ? "init rollback" : "close"}`, async () => {
    const { input, options, events } = await fixture(variant, init ? "app-init-fail" : "app");
    if (init) {
      let failure: unknown;
      try { await load(input, options); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);
      expect(String((failure as AggregateError).errors[0])).toContain("module_init returned 7");
    } else {
      const environment = await load(input, options);
      expect(() => environment.close()).toThrow();
      expect(environment.state).toBe("poisoned");
    }
    expect(guestTrace(events)).toContain(51);
    expect(guestTrace(events)).not.toContain(19);
  });
}

for (const [name, core, app, dependency, mutate] of [
  ["missing core dependency", "core", "app", false, (_f: any) => {}],
  ["aliased adapter namespace", "core", "app-alias", true, (_f: any) => {}],
  ["core using app adapter", "core-steal", "app", true, (_f: any) => {}],
  ["missing dispatcher", "core", "app-no-dispatch", true, (_f: any) => {}],
  ["wrong dispatcher signature", "core", "app-bad-dispatch", true, (_f: any) => {}],
  ["imported dispatcher", "core", "app-imported-dispatch", true, (_f: any) => {}],
  ["forged host factory", "core", "app", true, (f: any) => { f.options.hosts.push({ id: "host.label", interface: { name: "lvgl", version: 1 }, exports: [], create: () => { throw new Error("must not create"); } }); }],
  ["unauthorized core pointer export", "core", "app", true, (f: any) => { f.options.modules.find((item: any) => item.id === "lvcore").exports.push({ name: "lv_obj_create", params: ["i32"], results: ["i32"] }); }],
] as const) {
  test(`${name} is rejected before factories or guest code`, async () => {
    const f = await fixture(core, app, dependency);
    mutate(f);
    await expect(load(f.input, f.options)).rejects.toThrow();
    expect(f.factories()).toBe(0);
    expect(f.events).toEqual([]);
  });
}
