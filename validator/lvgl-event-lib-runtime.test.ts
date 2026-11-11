import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test as bunTest } from "bun:test";
import { inspectWasmFacts } from "../bindings/typescript/src/wasm-facts.ts";
import { exerciseEventLibrary } from "../tests/fixtures/feature-sdk/event-consumer.ts";
import { chainFixture } from "../tests/fixtures/feature-sdk/chain.ts";

const captured: WebAssembly.Instance[] = [];
const calls: string[] = [];
let failRemoval = false;
const descriptor = Object.getOwnPropertyDescriptor(WebAssembly, "Instance")!;
const OriginalInstance = WebAssembly.Instance;
const observer = new Proxy(OriginalInstance, {
  construct(target, args) {
    const instance = Reflect.construct(target, args, target) as WebAssembly.Instance;
    captured.push(instance);
    const kind = typeof instance.exports.lvw_init === "function" ? "core" : typeof instance.exports.app_run === "function" ? "app" : "middle";
    const exports = { ...instance.exports };
    for (const name of ["_initialize", "module_init", "module_close", "app_event_dispatch", "lvw_event_add", "lvw_event_remove", "lvw_shutdown"]) {
      const fn = instance.exports[name];
      if (typeof fn === "function") exports[name] = (...args: number[]) => {
        calls.push(`${kind}.${name}`);
        if (kind === "core" && name === "lvw_event_remove" && failRemoval) return 7;
        const result = fn(...args);
        calls.push(`${kind}.${name}:return`);
        return result;
      };
    }
    return new Proxy(instance, { get(target, key) { return key === "exports" ? exports : Reflect.get(target, key, target); } });
  },
});
let loadEnvironment: typeof import("../target/validator/feature-validator.js").loadNumericEnvironment;
try {
  Object.defineProperty(WebAssembly, "Instance", { ...descriptor, value: observer });
  ({ loadNumericEnvironment: loadEnvironment } = await import("../target/validator/feature-validator.js?event-lib-runtime"));
} finally { Object.defineProperty(WebAssembly, "Instance", descriptor); }

type Operation = { controller: AbortController; promise: ReturnType<typeof loadEnvironment> };
type Environment = Awaited<ReturnType<typeof loadEnvironment>>;
type Context = { ending: boolean; active: Set<Operation>; environments: Set<Environment>; errors: unknown[] };
const contexts = new AsyncLocalStorage<Context>();
let current: Context;
const test = (name: string, body: () => void | Promise<void>) => bunTest(name, () => {
  const context: Context = { ending: false, active: new Set(), environments: new Set(), errors: [] };
  current = context;
  captured.length = 0; calls.length = 0; failRemoval = false;
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
      timer = setTimeout(() => reject(new Error("event library test cleanup timed out")), 10_000);
    })]);
  } catch (error) { context.errors.push(error); } finally { clearTimeout(timer); }
  for (const environment of context.environments) {
    if (environment.state !== "ready") continue;
    try { environment.close(); } catch (error) { context.errors.push(error); }
  }
  context.environments.clear();
  if (context.errors.length) throw new AggregateError(context.errors, "event library test cleanup failed");
}, 30_000);

const path = Bun.env.LVW_TEST_EVENT_LIB_GRAPH;
if (!path) throw new Error("LVW_TEST_EVENT_LIB_GRAPH is required");
const graphBytes = await Bun.file(path).bytes();
const cases = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(graphBytes)) as { name: string; label: any; event: any }[];
function fixture(name = "real") {
  const result = chainFixture(graphBytes, name);
  const selected = cases.find((item) => item.name === name)!;
  const label = selected.label;
  if (!label || label.consumer !== "middle") throw new Error("invalid event library fixture");
  const cleanup: string[] = [];
  const options = { ...result.options, profile: "lvgl-event-v1" as const, label: { ...label }, event: { ...selected.event },
    hosts: result.options.hosts.map((host) => ({ ...host, create: (consumer: string, id: symbol) => {
      const instance = host.create(consumer, id);
      return { ...instance, close: () => { cleanup.push(consumer); instance.close(); } };
    } })) };
  return { ...result, options, cleanup };
}

async function compileFixture(wat: string) {
  const directory = await mkdtemp("target/validator/.event-lib-runtime-");
  try {
    const watPath = join(directory, "module.wat"), wasmPath = join(directory, "module.wasm");
    await Bun.write(watPath, wat);
    const build = Bun.spawnSync(["wasm-tools", "parse", watPath, "-o", wasmPath]);
    if (build.exitCode !== 0) throw new Error(build.stderr.toString());
    const validate = Bun.spawnSync(["wasm-tools", "validate", "--features=wasm1,reference-types", wasmPath]);
    if (validate.exitCode !== 0) throw new Error(validate.stderr.toString());
    return new Uint8Array(await Bun.file(wasmPath).arrayBuffer());
  } finally { await rm(directory, { recursive: true, force: true }); }
}

function replaceOnce(input: string, oldValue: string, newValue: string) {
  if (input.split(oldValue).length !== 2) throw new Error("test fixture replacement must match exactly once");
  return input.replace(oldValue, newValue);
}

function substituteModule(fixture: ReturnType<typeof fixture>, id: "middle" | "app", bytes: Uint8Array) {
  const module = fixture.input.modules.find(({ manifest }) => manifest.id === id)!;
  const facts = inspectWasmFacts(bytes);
  const type = (item: (typeof facts.imports)[number] | (typeof facts.exports)[number]) => item.kind === "function" || item.kind === "tag"
    ? { kind: item.kind, ...facts.types[item.typeIndex]! } : { kind: item.kind, ...item.type };
  const requirements = new Map<string, any>();
  for (const item of facts.imports) {
    const provider = item.module === "trace" ? "host.trace" : item.module === "lvgl" ? "host.label" : item.module;
    let requirement = requirements.get(provider);
    if (!requirement) { requirement = { provider, interface: item.module, version: 1, imports: [] }; requirements.set(provider, requirement); }
    requirement.imports.push({ module: item.module, name: item.name, provider_export: item.name, ...type(item) });
  }
  const manifest = module.manifest as any;
  manifest.artifact.sha256 = facts.sha256;
  manifest.requires = [...requirements.values()];
  manifest.exports = facts.exports.map((item) => ({ name: item.name, ...type(item) }));
  (module as any).bytes = bytes;
  (fixture.options.modules.find((item) => item.id === id) as any).sha256 = facts.sha256;
  fixture.options.maxTotalTableElements = fixture.input.modules.reduce((sum, item) => sum
    + inspectWasmFacts(item.bytes).tables.reduce((count, table) => count + Number(table.type.maximum), 0), 0);
}
const substituteMiddle = (fixture: ReturnType<typeof fixture>, bytes: Uint8Array) => substituteModule(fixture, "middle", bytes);

function coreInstance() {
  const core = captured.find((item) => typeof item.exports.lv_is_initialized === "function");
  if (!core) throw new Error("core instance was not captured");
  return core;
}
function initialized(core: WebAssembly.Instance) {
  // This explicit test observation is not a call made by the runtime.
  return (core.exports.lv_is_initialized as () => number)();
}
function frame(environment: Environment) {
  const value = environment.readFrame?.();
  if (!value) throw new Error("frame API is missing");
  expect(value.width).toBe(120); expect(value.height).toBe(48);
  expect(value.rgba.length).toBe(120 * 48 * 4);
  expect(value.rgba.every((byte, index) => index % 4 !== 3 || byte === 255)).toBe(true);
  return value.rgba;
}

const metadata = await Bun.file("target/wasm/api.json").json();
const clicked = Number(metadata.constants.find((item: any) => item.name === "LV_EVENT_CLICKED").value);
if (!Number.isSafeInteger(clicked) || clicked <= 0) throw new Error("invalid clicked code");
async function faultModule(transform: (wat: string) => string = (wat) => wat, index = 1) {
  let wat = await Bun.file("validator/lvgl-event-negative-app.wat").text();
  const replacements: Record<string, string> = { EVENT_MODULE: "lvgl",
    EXTRA_IMPORT: '(import "lvcore" "lv_is_initialized" (func $core (result i32)))',
    DISPATCH_EXPORT: '(func (export "app_event_dispatch") (param i32 i32) local.get 1 local.get 0 call_indirect (type $callback))',
    INDEX: `i32.const ${index}`, CODE: `i32.const ${clicked}`, INIT: "i32.const 0" };
  for (const [key, value] of Object.entries(replacements)) wat = wat.replaceAll(`@${key}@`, value);
  if (/@[A-Z_]+@/.test(wat)) throw new Error("unexpanded event fixture");
  wat = wat.replaceAll('"trace" "event"', '"trace" "lifecycle"').replaceAll("i32.const 123", `i32.const ${clicked}`)
    .replace('(export "app_run")', '(export "middle_update")');
  wat = replaceOnce(wat, '  (func (export "_initialize"))', '  (func (export "middle_active") (result i32) call $core)\n  (func (export "_initialize"))');
  return compileFixture(transform(wat));
}

function expectPoison(environment: Environment, action: () => unknown, expected: string) {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(String(failure).toLowerCase()).toContain(expected.toLowerCase());
  expect(environment.state).toBe("poisoned");
  const observed = calls.slice();
  for (const next of [() => environment.run(0), () => environment.readFrame?.(), () => environment.close()]) {
    let repeated: unknown;
    try { next(); } catch (error) { repeated = error; }
    expect(repeated).toBe(failure);
  }
  expect(calls).toEqual(observed);
  expect(initialized(coreInstance())).toBe(1);
  return failure;
}

test("real C library owns callback dispatch, nested userdata and target, frames and close", async () => {
  const result = await exerciseEventLibrary(graphBytes.buffer, load);
  expect(result).toEqual({ framesDiffer: true, otherUnchanged: true, survivesClose: true,
    traces: [[10, 20, 21, 11], [10, 20, 21, 11]], states: ["closed", "closed"] });
  expect(captured).toHaveLength(6);
  expect(new Set(captured.map((instance) => instance.exports.memory)).size).toBe(6);
  expect(captured.every((instance) => instance.exports.memory instanceof WebAssembly.Memory)).toBe(true);
  const apps = captured.filter((instance) => typeof instance.exports.app_run === "function");
  expect(apps).toHaveLength(2);
  expect(apps.every((instance) => !instance.exports.app_event_dispatch)).toBe(true);
  expect(calls.filter((call) => call === "middle.app_event_dispatch").length).toBe(8);
  expect(calls).not.toContain("app.app_event_dispatch");
  const close = calls.indexOf("middle.module_close");
  const returned = calls.indexOf("middle.module_close:return");
  expect(calls.slice(close, returned)).toContain("middle.app_event_dispatch");
  expect(calls[returned + 1]).toBe("core.lvw_event_remove");
  expect(calls[returned + 3]).toBe("core.lvw_shutdown");
  for (const core of captured.filter((instance) => typeof instance.exports.lvw_init === "function")) expect(initialized(core)).toBe(0);
});

test("real C init failures unregister before rollback of the same core", async () => {
  for (const [name, trace] of [["middle-fail-init", [10]], ["app-fail-init", [10, 20, 11]]] as const) {
    captured.length = 0; calls.length = 0;
    const f = fixture(name);
    await expect(load(f.input, f.options)).rejects.toThrow("module_init returned 7");
    expect([...f.traces.values()]).toEqual([trace]);
    expect(f.cleanup).toEqual(["app", "middle"]);
    expect(calls.filter((call) => call === "core.lvw_event_remove")).toHaveLength(1);
    expect(calls.indexOf("core.lvw_event_remove")).toBeLessThan(calls.indexOf("core.lvw_shutdown"));
    expect(initialized(coreInstance())).toBe(0);
  }
});

test("a library reactor can register and dispatch before module_init", async () => {
  for (const trap of [false, true]) {
    captured.length = 0; calls.length = 0;
    const f = fixture();
    substituteMiddle(f, await faultModule((wat) => {
      wat = replaceOnce(wat, '(func (export "module_init")', '(func $setup');
      return replaceOnce(wat, '(func (export "_initialize"))',
        `(func (export "_initialize") call $setup drop global.get $label i32.const ${clicked} i32.const 0 call $send drop ${trap ? "unreachable" : ""})\n`
        + '(func (export "module_init") (result i32) i32.const 33 call $trace i32.const 0)');
    }));
    if (trap) {
      await expect(load(f.input, f.options)).rejects.toThrow(/unreachable/i);
      expect([...f.traces.values()]).toEqual([[31, 70, 71]]);
      expect(calls).not.toContain("core.lvw_event_remove");
      expect(calls).not.toContain("core.lvw_shutdown");
      expect(initialized(coreInstance())).toBe(1);
    } else {
      const environment = await load(f.input, f.options);
      expect([...f.traces.values()]).toEqual([[31, 70, 71, 33, 20]]);
      frame(environment);
      environment.close();
      expect([...f.traces.values()]).toEqual([[31, 70, 71, 33, 20, 21, 39]]);
      expect(initialized(coreInstance())).toBe(0);
    }
    expect(f.cleanup).toEqual(["app", "middle"]);
  }
});

test("callback table bounds, null and signature traps poison the selected library", async () => {
  for (const index of [0, 2, 3, 4]) {
    captured.length = 0; calls.length = 0;
    const f = fixture();
    substituteMiddle(f, await faultModule(undefined, index));
    if (index === 0) {
      await expect(load(f.input, f.options)).rejects.toThrow("module_init returned 9");
      expect(initialized(coreInstance())).toBe(0);
    } else {
      const environment = await load(f.input, f.options);
      const failure = expectPoison(environment, () => environment.run(0), "");
      expect(failure).toBeInstanceOf(WebAssembly.RuntimeError);
      expect(f.cleanup).toEqual(["app", "middle"]);
    }
  }
});

test("library event frame, descriptor, parameter and nesting boundaries remain enforced", async () => {
  for (const [action, message] of [[3, "invalid LVGL event token"], [6, "unsupported LVGL event dispatch"],
    [9, "invalid LVGL event descriptor"], [1, "LVGL event nesting limit exceeded"]] as const) {
    captured.length = 0; calls.length = 0;
    const f = fixture();
    substituteMiddle(f, await faultModule());
    f.options.event.maxDepth = 1;
    const environment = await load(f.input, f.options);
    if (action === 3) expect(environment.run(0)).toBe(1);
    expectPoison(environment, () => environment.run(action), message);
    expect(f.cleanup).toEqual(["app", "middle"]);
  }
});

test("a foreign environment's event token is rejected inside the middle callback", async () => {
  const bytes = await faultModule((wat) => {
    wat = replaceOnce(wat, '  (global $label', '  (global $foreign (mut i32) (i32.const 0))\n  (global $label');
    wat = replaceOnce(wat, '    i32.const 70 call $trace',
      '    global.get $foreign if global.get $foreign call $code drop end\n    i32.const 70 call $trace');
    const start = wat.indexOf('  (func (export "middle_update")');
    return wat.slice(0, start) + `  (func (export "middle_update") (param i32) (result i32)
      local.get 0 i32.const -1 i32.eq if global.get $savedEvent return end
      local.get 0 global.set $foreign
      global.get $label i32.const ${clicked} i32.const 0 call $send drop global.get $count))`;
  });
  const a = fixture(), b = fixture();
  substituteMiddle(a, bytes); substituteMiddle(b, bytes);
  const first = await load(a.input, a.options), second = await load(b.input, b.options);
  expect(first.run(0)).toBe(1);
  const token = first.run(-1);
  expect(token).not.toBe(0);
  // The rejection must occur with a different, currently active frame in the second environment.
  expectPoison(second, () => second.run(token), "invalid LVGL event token");
  expect(first.run(0)).toBe(2);
  first.close();
});

test("library close errors stop core shutdown during close and app init rollback", async () => {
  for (const trap of [false, true]) for (const rollback of [false, true]) {
    captured.length = 0; calls.length = 0;
    const f = fixture(rollback ? "app-fail-init" : "real");
    substituteMiddle(f, await faultModule((wat) => replaceOnce(wat,
      '(func (export "module_close") (result i32) i32.const 39 call $trace i32.const 0)',
      `(func (export "module_close") (result i32) i32.const 39 call $trace ${trap ? "unreachable" : "i32.const 7"})`)));
    if (rollback) {
      let failure: unknown;
      try { await load(f.input, f.options); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);
      expect(String((failure as AggregateError).errors[0])).toContain('"app": module_init returned 7');
      expect(String((failure as AggregateError).errors[1]).toLowerCase()).toContain(trap ? "unreachable" : '"middle": module_close returned 7');
    } else {
      const environment = await load(f.input, f.options);
      expectPoison(environment, () => environment.close(), trap ? "unreachable" : '"middle": module_close returned 7');
    }
    expect(calls).not.toContain("core.lvw_event_remove");
    expect(calls).not.toContain("core.lvw_shutdown");
    expect(initialized(coreInstance())).toBe(1);
    expect(f.cleanup).toEqual(["app", "middle"]);
  }
});

test("failed native unsubscribe and host cleanup retain the first library close failure", async () => {
  const f = fixture();
  const cleanupFailure = new Error("test host cleanup failed");
  f.options.hosts = f.options.hosts.map((host) => ({ ...host, create: (consumer: string, id: symbol) => {
    const instance = host.create(consumer, id);
    return { ...instance, close: () => { instance.close(); if (consumer === "middle") throw cleanupFailure; } };
  } }));
  const environment = await load(f.input, f.options);
  environment.run(11);
  // Controlled export instrumentation simulates an unsubscribe failure, not a defect in the fixed core.
  failRemoval = true;
  const failure = expectPoison(environment, () => environment.close(), "numeric environment cleanup failed");
  expect(failure).toBeInstanceOf(AggregateError);
  expect(String((failure as AggregateError).errors[0])).toContain("LVGL event removal failed (7)");
  expect((failure as AggregateError).errors[1]).toBe(cleanupFailure);
  expect(calls).not.toContain("core.lvw_shutdown");
  expect(f.cleanup).toEqual(["app", "middle"]);
});

test("host failure inside the middle callback is sticky and prevents later guest calls", async () => {
  const f = fixture();
  substituteMiddle(f, await faultModule());
  const failure = new Error("test callback host failure");
  f.options.hosts = f.options.hosts.map((host) => ({ ...host, create: (consumer: string, id: symbol) => {
    const instance = host.create(consumer, id);
    return { ...instance, exports: { lifecycle: (value: number) => {
      if (value === 70) throw failure;
      return instance.exports.lifecycle!(value);
    } } };
  } }));
  const environment = await load(f.input, f.options);
  expect(expectPoison(environment, () => environment.run(0), failure.message)).toBe(failure);
  expect(f.cleanup).toEqual(["app", "middle"]);
  expect([...f.traces.values()]).toEqual([[31, 20]]);
});
