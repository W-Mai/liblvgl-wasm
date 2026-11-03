import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, test as bunTest } from "bun:test";
import { inspectWasmFacts } from "../bindings/typescript/src/wasm-facts.ts";
import { loadNumericEnvironment as loadEnvironment } from "../target/validator/feature-validator.js";

type Operation = { controller: AbortController; promise: ReturnType<typeof loadEnvironment> };
type Environment = Awaited<ReturnType<typeof loadEnvironment>>;
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
      timer = setTimeout(() => reject(new Error("label test cleanup timed out")), 10_000);
    })]);
  } catch (error) { context.errors.push(error); } finally { clearTimeout(timer); }
  for (const environment of context.environments) {
    if (environment.state !== "ready") continue;
    try { environment.close(); } catch (error) { context.errors.push(error); }
  }
  context.environments.clear();
  if (context.errors.length) throw new AggregateError(context.errors, "label test cleanup failed");
}, 30_000);

async function fixture(coreVariant = "core", appVariant = "app", dependency = true) {
  const records = await Promise.all([["lvcore", coreVariant], ["app", appVariant]].map(async ([id, name]) => {
    const bytes = await Bun.file(`target/validator/lvgl-label-negative/${name}.wasm`).bytes();
    return { id: id!, bytes, facts: inspectWasmFacts(bytes) };
  }));
  const core = records[0]!, app = records[1]!;
  const signature = (facts: typeof core.facts, item: (typeof core.facts.imports)[number] | (typeof core.facts.exports)[number]) => {
    if (item.kind === "function" || item.kind === "tag") return { name: item.name, kind: item.kind, ...facts.types[item.typeIndex]! };
    return { name: item.name, kind: item.kind, ...item.type };
  };
  const imports = (record: typeof core, namespace: string) => record.facts.imports.filter((item) => item.module === namespace)
    .map((item) => ({ ...signature(record.facts, item), module: item.module, provider_export: item.name }));
  const labelNamespace = appVariant === "app-alias" ? "not-lvgl" : "lvgl";
  const lvwImports = imports(core, "lvw"), coreLabelImports = imports(core, "lvgl"), labelImports = imports(app, labelNamespace);
  const requirement = (provider: string, interfaceName: string, items: object[]) => ({ provider, interface: interfaceName, version: 1, imports: items });
  const exports = (items: typeof labelImports) => items.map(({ name, kind, ...item }) => {
    const { module: _module, provider_export: _provider, ...type } = item;
    return { name, kind, ...type };
  });
  const coreRequires = [requirement("host.trace", "trace", imports(core, "trace")), requirement("host.lvw", "lvw", lvwImports),
    ...(coreLabelImports.length ? [requirement("host.label", "lvgl", coreLabelImports)] : [])];
  const appRequires = [requirement("host.trace", "trace", imports(app, "trace")),
    requirement("host.label", "lvgl", labelImports), ...(dependency ? [requirement("lvcore", "lvcore", [])] : [])];
  const iface = (name: string) => ({ name, version: 1 });
  const modules = records.map(({ id, bytes, facts }) => ({ bytes, manifest: {
    schema_version: 1, kind: "wasm-module", id, role: id === "app" ? "app" : "lib",
    artifact: { path: `${id}.wasm`, sha256: facts.sha256 }, target: { abi: "wasip1", features: [] },
    interface: iface(id), memory_model: "isolated", runtime_verification: "not-run",
    requires: id === "app" ? appRequires : coreRequires, exports: facts.exports.map((item) => signature(facts, item)),
  } }));
  const trace = { name: "event", kind: "function", params: ["i32"], results: [] };
  const input: any = { modules, hosts: [{ id: "host.trace", interface: iface("trace"), exports: [trace] },
    { id: "host.lvw", interface: iface("lvw"), exports: exports(lvwImports) },
    { id: "host.label", interface: iface("lvgl"), exports: exports(labelImports) }] };
  const events: (number | string)[] = [];
  let factories = 0;
  const options: any = { profile: "lvgl-label-v1", lvgl: { module: "lvcore", id: "host.lvw", interface: iface("lvw"), abiVersion: 1 },
    label: { id: "host.label", interface: iface("lvgl"), width: 8, height: 8, maxLabels: 1, maxTextBytes: 4 },
    modules: modules.map(({ manifest }) => ({ id: manifest.id, sha256: manifest.artifact.sha256, interface: manifest.interface, exports: [] })),
    hosts: [{ id: "host.trace", interface: iface("trace"), exports: [{ name: "event", params: ["i32"], results: [] }],
      create: (consumer: string) => { factories++; return { exports: { event: (value: number) => { events.push(value); } },
        close: () => { events.push(`host:${consumer}`); } }; } }],
    allowedFeatures: [], startupTimeoutMs: 30_000, executionTimeoutMs: 30_000,
    maxMemoryPages: 2, maxTotalMemoryPages: 4, maxTableElements: 0, maxTotalTableElements: 0 };
  return { input, options, events, factories: () => factories };
}

const guestTrace = (values: (number | string)[]) => values.filter((value) => typeof value === "number");

test("a label call uses core scratch and releases it after success", async () => {
  const { input, options, events } = await fixture();
  const environment = await load(input, options);
  const token = environment.run(0);
  expect(token).not.toBe(0);
  expect(environment.state).toBe("ready");
  expect(guestTrace(events).filter((value) => value === 50)).toHaveLength(1);
  expect(guestTrace(events).filter((value) => value === 43)).toHaveLength(1);
  expect(guestTrace(events).filter((value) => value === 51)).toHaveLength(1);
  environment.close();
  expect(guestTrace(events).indexOf(39)).toBeLessThan(guestTrace(events).indexOf(19));
});

test("NULL refresh does not allocate temporary core text", async () => {
  const { input, options, events } = await fixture();
  const environment = await load(input, options);
  environment.run(-7);
  expect(guestTrace(events).filter((value) => value === 43)).toHaveLength(1);
  expect(guestTrace(events)).not.toContain(50);
  expect(guestTrace(events)).not.toContain(51);
  environment.close();
});

test("application memory growth is observed before copying", async () => {
  const { input, options, events } = await fixture();
  const environment = await load(input, options);
  expect(environment.run(-6)).not.toBe(0);
  expect(environment.state).toBe("ready");
  expect(guestTrace(events)).toContain(43);
  environment.close();
});

test("the adapter uses its own display even when the core default differs", async () => {
  const { input, options, events } = await fixture("core-foreign-default");
  const environment = await load(input, options);
  expect(environment.run(0)).not.toBe(0);
  expect(environment.state).toBe("ready");
  expect(guestTrace(events)).toContain(43);
  environment.close();
});

test("the app reactor can call its adapter after its private memory is bound", async () => {
  const { input, options, events } = await fixture("core", "app-reactor-use");
  const environment = await load(input, options);
  expect(environment.state).toBe("ready");
  expect(guestTrace(events)).toContain(42);
  expect(guestTrace(events).indexOf(42)).toBeLessThan(guestTrace(events).indexOf(31));
  environment.close();
});

test("invalid frame metadata poisons before any further core cleanup", async () => {
  const { input, options, events } = await fixture();
  const environment = await load(input, options);
  expect(() => (environment as any).readFrame()).toThrow("invalid LVGL frame metadata");
  expect(environment.state).toBe("poisoned");
  const trace = guestTrace(events), read = trace.lastIndexOf(53);
  expect(read).toBeGreaterThanOrEqual(0);
  expect(trace.slice(read + 1)).not.toContain(51);
  expect(trace).not.toContain(19);
  expect(() => environment.close()).toThrow();
});

test("frame pixels are converted to an independent RGBA copy", async () => {
  const { input, options } = await fixture("core-valid-frame");
  const environment = await load(input, options);
  const first = (environment as any).readFrame();
  expect({ width: first.width, height: first.height, frameId: first.frameId }).toEqual({ width: 8, height: 8, frameId: 123 });
  expect([...first.rgba.slice(0, 8)]).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
  first.rgba[0] = 99;
  expect((environment as any).readFrame().rgba[0]).toBe(1);
  environment.close();
  expect(() => (environment as any).readFrame()).toThrow();
});

for (const [name, variant] of [["NULL", "core-null-frame"], ["out-of-bounds", "core-oob-frame"]] as const) {
  test(`a ${name} native pixel pointer is rejected`, async () => {
    const { input, options, events } = await fixture(variant);
    const environment = await load(input, options);
    expect(() => (environment as any).readFrame()).toThrow("invalid LVGL frame metadata");
    expect(environment.state).toBe("poisoned");
    expect(guestTrace(events)).toContain(53);
    expect(guestTrace(events)).not.toContain(51);
    expect(guestTrace(events)).not.toContain(19);
  });
}

test("a caught reentrant call still poisons the outer adapter call", async () => {
  const { input, options, events } = await fixture();
  let environment: Environment;
  const create = options.hosts[0].create;
  options.hosts[0].create = (consumer: string, id: symbol) => {
    const host = create(consumer, id), event = host.exports.event;
    host.exports.event = (value: number) => {
      event(value);
      if (value === 42) { try { environment.close(); } catch { /* The outer call must retain the failure. */ } }
    };
    return host;
  };
  environment = await load(input, options);
  expect(() => environment.run(0)).toThrow("not reentrant");
  expect(environment.state).toBe("poisoned");
  expect(guestTrace(events)).toContain(42);
  expect(guestTrace(events)).not.toContain(43);
  expect(guestTrace(events)).not.toContain(19);
  expect(() => environment.close()).toThrow("not reentrant");
});

for (const [name, action] of [["out-of-bounds string", -1], ["unterminated string", -2],
  ["screen used as label", -3], ["label quota", -4], ["overlong string", -5]] as const) {
  test(`${name} poisons the environment before text is passed to core`, async () => {
    const { input, options, events } = await fixture();
    const environment = await load(input, options);
    expect(() => environment.run(action)).toThrow();
    expect(environment.state).toBe("poisoned");
    expect(guestTrace(events)).not.toContain(43);
    expect(guestTrace(events)).not.toContain(51);
    expect(guestTrace(events)).not.toContain(19);
    expect(() => environment.close()).toThrow();
  });
}

for (const [variant, setter, freed] of [["core-alloc-zero", false, false], ["core-alloc-trap", false, false],
  ["core-alloc-oob", false, false], ["core-set-trap", true, false], ["core-event", true, false],
  ["core-free-trap", true, true]] as const) {
  test(`${variant} never continues guest cleanup after failure`, async () => {
    const { input, options, events } = await fixture(variant);
    const environment = await load(input, options);
    expect(() => environment.run(0)).toThrow();
    expect(environment.state).toBe("poisoned");
    expect(guestTrace(events)).toContain(50);
    expect(guestTrace(events).includes(43)).toBe(setter);
    expect(guestTrace(events).includes(51)).toBe(freed);
    expect(guestTrace(events)).not.toContain(19);
    expect(() => environment.close()).toThrow();
  });
}

test("a native NULL label does not fabricate a handle or poison the graph", async () => {
  const { input, options, events } = await fixture("core-create-zero");
  const environment = await load(input, options);
  expect(environment.run(0)).toBe(0);
  expect(environment.run(0)).toBe(0);
  expect(environment.state).toBe("ready");
  expect(guestTrace(events)).toContain(42);
  expect(guestTrace(events)).not.toContain(43);
  environment.close();
});

test("a display failure rolls back core before app initialization", async () => {
  const { input, options, events } = await fixture("core-display-zero");
  await expect(load(input, options)).rejects.toThrow();
  expect(guestTrace(events)).toContain(40);
  expect(guestTrace(events)).toContain(19);
  expect(guestTrace(events)).not.toContain(31);
});

test("failed app initialization rolls back a core that owns a created label", async () => {
  const { input, options, events } = await fixture("core", "app-init-fail");
  await expect(load(input, options)).rejects.toThrow("module_init returned 7");
  expect(guestTrace(events)).toContain(42);
  expect(guestTrace(events)).toContain(19);
  expect(guestTrace(events)).not.toContain(39);
});

test("a token from another environment is rejected even for the same core address", async () => {
  const first = await fixture(), second = await fixture();
  const a = await load(first.input, first.options), b = await load(second.input, second.options);
  const aToken = a.run(0), bToken = b.run(0);
  expect(aToken).not.toBe(bToken);
  const before = guestTrace(second.events).filter((value) => value === 43).length;
  expect(() => b.run(aToken)).toThrow();
  expect(b.state).toBe("poisoned");
  expect(guestTrace(second.events).filter((value) => value === 43)).toHaveLength(before);
  expect(a.state).toBe("ready");
  a.close();
});

test("a token retained after failed app initialization is rejected in a new environment", async () => {
  const failed = await fixture("core", "app-init-save-fail");
  await expect(load(failed.input, failed.options)).rejects.toThrow("module_init returned 7");
  const trace = guestTrace(failed.events), create = trace.lastIndexOf(42);
  expect(create).toBeGreaterThanOrEqual(0);
  const oldToken = trace[create + 1]!;
  expect(oldToken).toBeGreaterThan(0);
  const next = await fixture();
  const environment = await load(next.input, next.options);
  const newToken = environment.run(0);
  expect(oldToken).not.toBe(newToken);
  const before = guestTrace(next.events).filter((value) => value === 43).length;
  expect(() => environment.run(oldToken)).toThrow();
  expect(environment.state).toBe("poisoned");
  expect(guestTrace(next.events).filter((value) => value === 43)).toHaveLength(before);
});

for (const [name, core, app, dependency, message, mutate] of [
  ["missing explicit core dependency", "core", "app", false, "label app must depend on its LVGL core", (_f: any) => {}],
  ["aliased adapter namespace", "core", "app-alias", true, "LVGL label import is not authorized", (_f: any) => {}],
  ["wrong adapter signature", "core", "app-bad-signature", true, "LVGL label host contract differs", (_f: any) => {}],
  ["core stealing app adapter", "core-steal", "app", true, "LVGL label host is reserved for its app", (_f: any) => {}],
  ["app memory not exported", "core", "app-no-memory", true, "label profile requires owned exported memory", (_f: any) => {}],
  ["core memory not exported", "core-no-memory", "app", true, "label profile requires owned exported memory", (_f: any) => {}],
  ["adapter identity conflicts with lvw", "core", "app", true, "LVGL label provider identity conflicts", (f: any) => { f.options.label.id = "host.lvw"; }],
  ["adapter identity conflicts with numeric host", "core", "app", true, "LVGL label provider identity conflicts", (f: any) => { f.options.label.id = "host.trace"; }],
  ["zero display width", "core", "app", true, "invalid LVGL label limits", (f: any) => { f.options.label.width = 0; }],
  ["oversized frame", "core", "app", true, "invalid LVGL label limits", (f: any) => { f.options.label.width = 4096; f.options.label.height = 1025; }],
  ["zero label quota", "core", "app", true, "invalid LVGL label limits", (f: any) => { f.options.label.maxLabels = 0; }],
  ["zero text limit", "core", "app", true, "invalid LVGL label limits", (f: any) => { f.options.label.maxTextBytes = 0; }],
  ["aggregate memory over budget", "core", "app", true, "numeric environment resource limit exceeded", (f: any) => { f.options.maxTotalMemoryPages = 3; }],
  ["untrusted core identity", "core", "app", true, "numeric module is not authorized", (f: any) => { f.options.modules.find((m: any) => m.id === "lvcore").sha256 = "0".repeat(64); }],
  ["pointer-like core export", "core", "app", true, "unsupported LVGL scalar export", (f: any) => { f.options.modules.find((m: any) => m.id === "lvcore").exports.push({ name: "lv_obj_create", params: ["i32"], results: ["i32"] }); }],
] as const) {
  test(`${name} is rejected before factories or guest code`, async () => {
    const f = await fixture(core, app, dependency);
    mutate(f);
    await expect(load(f.input, f.options)).rejects.toThrow(message);
    expect(f.factories()).toBe(0);
    expect(f.events).toEqual([]);
  });
}
