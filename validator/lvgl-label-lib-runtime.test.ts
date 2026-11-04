import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test as bunTest } from "bun:test";
import { inspectWasmFacts } from "../bindings/typescript/src/wasm-facts.ts";
import { chainFixture } from "../tests/fixtures/feature-sdk/chain.ts";

const captured: WebAssembly.Instance[] = [];
const descriptor = Object.getOwnPropertyDescriptor(WebAssembly, "Instance")!;
const OriginalInstance = WebAssembly.Instance;
const observer = new Proxy(OriginalInstance, {
  construct(target, args) {
    const instance = Reflect.construct(target, args, target) as WebAssembly.Instance;
    captured.push(instance);
    return instance;
  },
});
let loadEnvironment: typeof import("../target/validator/feature-validator.js").loadNumericEnvironment;
try {
  Object.defineProperty(WebAssembly, "Instance", { ...descriptor, value: observer });
  ({ loadNumericEnvironment: loadEnvironment } = await import("../target/validator/feature-validator.js?label-lib-runtime"));
} finally { Object.defineProperty(WebAssembly, "Instance", descriptor); }

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
      timer = setTimeout(() => reject(new Error("label library test cleanup timed out")), 10_000);
    })]);
  } catch (error) { context.errors.push(error); } finally { clearTimeout(timer); }
  for (const environment of context.environments) {
    if (environment.state !== "ready") continue;
    try { environment.close(); } catch (error) { context.errors.push(error); }
  }
  context.environments.clear();
  if (context.errors.length) throw new AggregateError(context.errors, "label library test cleanup failed");
}, 30_000);

const path = Bun.env.LVW_TEST_LABEL_LIB_GRAPH;
if (!path) throw new Error("LVW_TEST_LABEL_LIB_GRAPH is required");
const graphBytes = await Bun.file(path).bytes();
const cases = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(graphBytes)) as { name: string; label: any }[];
function fixture(name = "real") {
  const result = chainFixture(graphBytes, name);
  const label = cases.find((item) => item.name === name)?.label;
  if (!label || label.consumer !== "middle") throw new Error("invalid label library fixture");
  const cleanup: string[] = [];
  const options = { ...result.options, profile: "lvgl-label-v1" as const, label: { ...label },
    hosts: result.options.hosts.map((host) => ({ ...host, create: (consumer: string, id: symbol) => {
      const instance = host.create(consumer, id);
      return { ...instance, close: () => { cleanup.push(consumer); instance.close(); } };
    } })) };
  return { ...result, options, cleanup };
}

async function compileFixture(wat: string) {
  const directory = await mkdtemp("target/validator/.label-lib-runtime-");
  try {
    const watPath = join(directory, "module.wat"), wasmPath = join(directory, "module.wasm");
    await Bun.write(watPath, wat);
    const build = Bun.spawnSync(["wasm-tools", "parse", watPath, "-o", wasmPath]);
    if (build.exitCode !== 0) throw new Error(build.stderr.toString());
    const validate = Bun.spawnSync(["wasm-tools", "validate", "--features=wasm1", wasmPath]);
    if (validate.exitCode !== 0) throw new Error(validate.stderr.toString());
    return new Uint8Array(await Bun.file(wasmPath).arrayBuffer());
  } finally { await rm(directory, { recursive: true, force: true }); }
}

async function faultModule(transform: (wat: string) => string = (wat) => wat) {
  return compileFixture(transform(await Bun.file("validator/lvgl-label-lib-runtime.wat").text()));
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

test("real C label library renders independently in two environments", async () => {
  captured.length = 0;
  const first = fixture(), second = fixture();
  const a = await load(first.input, first.options), b = await load(second.input, second.options);
  expect(captured).toHaveLength(6);
  const memories = captured.map((instance) => instance.exports.memory);
  expect(memories.every((memory) => memory instanceof WebAssembly.Memory)).toBe(true);
  expect(new Set(memories).size).toBe(6);
  const a0 = frame(a), b0 = frame(b);
  expect(a0).toEqual(b0);
  expect(a.run(1)).toBe(1);
  const a1 = frame(a);
  expect(a1).not.toEqual(a0);
  expect(frame(b)).toEqual(b0);
  expect(b.run(0)).toBe(0);
  expect(b.run(1)).toBe(1);
  expect(frame(b)).toEqual(a1);
  expect(a.run(2)).toBe(2);
  expect(frame(a)).toEqual(a0);
  expect(frame(b)).toEqual(a1);
  const retained = a1.slice();
  a.close();
  expect(a1).toEqual(retained);
  expect(b.run(2)).toBe(2);
  expect(frame(b)).toEqual(a0);
  b.close();
  expect([...first.traces.values()]).toEqual([[10, 20, 21, 11]]);
  expect([...second.traces.values()]).toEqual([[10, 20, 21, 11]]);
  const cores = captured.filter((item) => typeof item.exports.lv_is_initialized === "function");
  expect(cores).toHaveLength(2);
  for (const core of cores) expect(initialized(core)).toBe(0);
  expect(first.cleanup).toEqual(["app", "middle"]);
  expect(second.cleanup).toEqual(["app", "middle"]);
});

test("real C initialization failures roll back in reverse order", async () => {
  for (const [name, trace] of [["middle-fail-init", [10]], ["app-fail-init", [10, 20, 11]]] as const) {
    captured.length = 0;
    const f = fixture(name);
    await expect(load(f.input, f.options), name).rejects.toThrow("module_init returned 7");
    expect([...f.traces.values()], name).toEqual([trace]);
    expect(initialized(coreInstance()), name).toBe(0);
    expect(f.cleanup, name).toEqual(["app", "middle"]);
  }
});

test("middle traps and invalid label arguments poison without further runtime guest calls", async () => {
  const bytes = await faultModule();
  for (const [action, expected] of [[-1, "unreachable"], [-2, "invalid LVGL label handle"],
    [-3, "LVGL text pointer is out of bounds"], [-4, "LVGL text is unterminated or too long"],
    [-5, "LVGL label quota exceeded"]] as const) {
    captured.length = 0;
    const f = fixture();
    f.options.label.maxLabels = 1;
    substituteMiddle(f, bytes);
    const environment = await load(f.input, f.options);
    const core = coreInstance();
    expect(initialized(core)).toBe(1);
    let failure: unknown;
    try { environment.run(action); } catch (error) { failure = error; }
    if (action === -1) expect(failure).toBeInstanceOf(WebAssembly.RuntimeError);
    expect(String(failure).toLowerCase()).toContain(expected.toLowerCase());
    expect(environment.state).toBe("poisoned");
    let runFailure: unknown, closeFailure: unknown;
    try { environment.run(0); } catch (error) { runFailure = error; }
    try { environment.close(); } catch (error) { closeFailure = error; }
    expect(runFailure).toBe(failure); expect(closeFailure).toBe(failure);
    expect([...f.traces.values()]).toEqual([[10, 20]]);
    expect(f.cleanup).toEqual(["app", "middle"]);
    expect(initialized(core)).toBe(1);
  }
});

test("middle memory growth is observed before text is copied to the core", async () => {
  const f = fixture();
  substituteMiddle(f, await faultModule());
  const environment = await load(f.input, f.options);
  const before = frame(environment);
  expect(environment.run(-6)).toBe(0);
  expect(frame(environment)).not.toEqual(before);
  environment.close();
  expect([...f.traces.values()]).toEqual([[10, 20, 21, 11]]);
});

test("test-only label tokens cannot cross or outlive environments in the same SDK realm", async () => {
  const bytes = await faultModule();
  const first = fixture(), second = fixture();
  substituteMiddle(first, bytes); substituteMiddle(second, bytes);
  const a = await load(first.input, first.options), b = await load(second.input, second.options);
  // This fixture-only probe exposes a token; numeric business contracts must not do so.
  const token = a.run(-7);
  expect(token).toBeGreaterThan(0);
  expect(() => b.run(token)).toThrow("invalid LVGL label handle");
  expect(b.state).toBe("poisoned");
  expect([...second.traces.values()]).toEqual([[10, 20]]);
  expect(second.cleanup).toEqual(["app", "middle"]);
  a.close();
  const third = fixture();
  substituteMiddle(third, bytes);
  const c = await load(third.input, third.options);
  expect(() => c.run(token)).toThrow("invalid LVGL label handle");
  expect(c.state).toBe("poisoned");
  expect([...third.traces.values()]).toEqual([[10, 20]]);
  expect(third.cleanup).toEqual(["app", "middle"]);
});

test("an out-of-bounds app data segment stops without closing initialized libraries", async () => {
  const f = fixture();
  let wat = await Bun.file("validator/lvgl-label-lib-app.wat").text();
  wat = replaceOnce(wat, "@EXTRA_IMPORT@", "");
  wat = replaceOnce(wat, "@EXTRA@", '(data (i32.const 131071) "xx")');
  substituteModule(f, "app", await compileFixture(wat));
  captured.length = 0;
  let failure: unknown;
  try { await load(f.input, f.options); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(WebAssembly.RuntimeError);
  expect(String(failure).toLowerCase()).toContain("data segment");
  expect(String(failure).toLowerCase()).toContain("memory");
  expect([...f.traces.values()]).toEqual([[10]]);
  expect(f.cleanup).toEqual(["app", "middle"]);
  expect(initialized(coreInstance())).toBe(1);
});

test("middle reactor can call the label adapter and a reactor trap stops initialization", async () => {
  const reactor = '(func (export "_initialize") i32.const 5 call $trace call $screen call $create i32.const 64 call $set @END@)';
  for (const trap of [false, true]) {
    captured.length = 0;
    const f = fixture();
    const bytes = await faultModule((wat) => replaceOnce(wat, '  (func (export "module_init")',
      `  ${reactor.replace("@END@", trap ? "unreachable" : "")}\n  (func (export "module_init")`));
    substituteMiddle(f, bytes);
    if (trap) {
      let failure: unknown;
      try { await load(f.input, f.options); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(WebAssembly.RuntimeError);
      expect(String(failure).toLowerCase()).toContain("unreachable");
      expect([...f.traces.values()]).toEqual([[5]]);
      expect(f.cleanup).toEqual(["app", "middle"]);
      expect(initialized(coreInstance())).toBe(1);
    } else {
      const environment = await load(f.input, f.options);
      expect([...f.traces.values()]).toEqual([[5, 10, 20]]);
      frame(environment);
      environment.close();
      expect([...f.traces.values()]).toEqual([[5, 10, 20, 21, 11]]);
      expect(initialized(coreInstance())).toBe(0);
    }
  }
});

test("middle close failure stops core shutdown during close and initialization rollback", async () => {
  for (const mode of ["nonzero", "trap"] as const) for (const rollback of [false, true]) {
    captured.length = 0;
    const f = fixture(rollback ? "app-fail-init" : "real");
    const bytes = await faultModule((wat) => replaceOnce(wat, '    i32.const 11 call $trace\n    i32.const 0)',
      `    i32.const 11 call $trace\n    ${mode === "trap" ? "unreachable" : "i32.const 7"})`));
    substituteMiddle(f, bytes);
    const expected = mode === "trap" ? "unreachable" : '"middle": module_close returned 7';
    let failure: unknown;
    if (rollback) {
      try { await load(f.input, f.options); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);
      const errors = (failure as AggregateError).errors;
      expect(String(errors[0])).toContain('"app": module_init returned 7');
      if (mode === "trap") expect(errors[1]).toBeInstanceOf(WebAssembly.RuntimeError);
      expect(String(errors[1]).toLowerCase()).toContain(expected.toLowerCase());
      expect([...f.traces.values()]).toEqual([[10, 20, 11]]);
    } else {
      const environment = await load(f.input, f.options);
      try { environment.close(); } catch (error) { failure = error; }
      if (mode === "trap") expect(failure).toBeInstanceOf(WebAssembly.RuntimeError);
      expect(String(failure).toLowerCase()).toContain(expected.toLowerCase());
      expect(environment.state).toBe("poisoned");
      let next: unknown, close: unknown;
      try { environment.run(0); } catch (error) { next = error; }
      try { environment.close(); } catch (error) { close = error; }
      expect(next).toBe(failure); expect(close).toBe(failure);
      expect([...f.traces.values()]).toEqual([[10, 20, 21, 11]]);
    }
    expect(f.cleanup).toEqual(["app", "middle"]);
    expect(initialized(coreInstance())).toBe(1);
  }
});

test("rollback preserves initialization, guest trap, and host cleanup errors", async () => {
  captured.length = 0;
  const f = fixture("app-fail-init");
  substituteMiddle(f, await faultModule((wat) => replaceOnce(wat, '    i32.const 11 call $trace\n    i32.const 0)',
    '    i32.const 11 call $trace\n    unreachable)')));
  const cleanupFailure = new Error("test host cleanup failed");
  f.options.hosts = f.options.hosts.map((host) => ({ ...host, create: (consumer: string, id: symbol) => {
    const instance = host.create(consumer, id);
    return { ...instance, close: () => { instance.close(); if (consumer === "middle") throw cleanupFailure; } };
  } }));
  let failure: unknown;
  try { await load(f.input, f.options); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  const errors = (failure as AggregateError).errors;
  expect(String(errors[0])).toContain('"app": module_init returned 7');
  expect(errors[1]).toBeInstanceOf(AggregateError);
  const cleanup = (errors[1] as AggregateError).errors;
  expect(cleanup[0]).toBeInstanceOf(WebAssembly.RuntimeError);
  expect(String(cleanup[0]).toLowerCase()).toContain("unreachable");
  expect(cleanup[1]).toBe(cleanupFailure);
  expect([...f.traces.values()]).toEqual([[10, 20, 11]]);
  expect(f.cleanup).toEqual(["app", "middle"]);
  expect(initialized(coreInstance())).toBe(1);
});
