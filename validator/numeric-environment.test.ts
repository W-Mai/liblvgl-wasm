import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, test as bunTest } from "bun:test";
import { loadNumericEnvironment as loadEnvironment } from "../target/validator/feature-validator.js";
import { prepareModuleManifests } from "../bindings/typescript/src/module-manifest.ts";
import { compileNumericModules, prepareNumericProfile } from "../bindings/typescript/src/numeric-environment.ts";

type Operation = { controller: AbortController; promise: ReturnType<typeof loadEnvironment> };
type Environment = Awaited<ReturnType<typeof loadEnvironment>>;
type Context = { ending: boolean; active: Set<Operation>; environments: Set<Environment>; cleanupErrors: unknown[] };
const contexts = new AsyncLocalStorage<Context>();
let current: Context;
const test = (name: string, body: () => void | Promise<void>) => bunTest(name, () => {
  const context: Context = { ending: false, active: new Set(), environments: new Set(), cleanupErrors: [] };
  current = context;
  const completion = contexts.run(context, () => Promise.resolve().then(body));
  return completion.catch((error: unknown) => { if (!context.ending) throw error; });
}, 300_000);

function loadNumericEnvironment(input: Parameters<typeof loadEnvironment>[0], options: Parameters<typeof loadEnvironment>[1]) {
  const context = contexts.getStore()!;
  if (context.ending) return Promise.reject(new Error("test cleanup in progress"));
  const controller = new AbortController();
  const signal = options.signal;
  const forwardAbort = () => controller.abort();
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  const promise = loadEnvironment(input, { ...options, signal: controller.signal });
  const operation = { controller, promise };
  context.active.add(operation);
  const release = () => { signal?.removeEventListener("abort", forwardAbort); context.active.delete(operation); };
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
      timer = setTimeout(() => reject(new Error("numeric test cleanup timed out")), 10_000);
    })]);
  } catch (error) { errors.push(error); } finally { clearTimeout(timer); }
  for (const environment of context.environments) {
    if (environment.state !== "ready") continue;
    try { environment.close(); } catch (error) { errors.push(error); }
  }
  context.environments.clear();
  errors.push(...context.cleanupErrors);
  if (errors.length) throw new AggregateError(errors, "numeric test cleanup failed");
}, 30_000);

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const signature = (name: string, params: string[], results: string[]) => ({ name, kind: "function", params, results });
const calc = signature("calc", ["i32"], ["i32"]);
const read = signature("read", [], ["i32"]);
const lifecycle = [signature("_initialize", [], []), signature("module_init", [], ["i32"]), signature("module_close", [], ["i32"])];
const trace = signature("event", ["i32"], []);

async function fixture(app = "app", onEvent?: (consumer: string, value: number) => void, b = "b", variants: Record<string, string> = {}) {
  const bytes = Object.fromEntries(await Promise.all(["core", "b", "a", "app"].map(async (id) =>
    [id, await Bun.file(`target/validator/numeric-fixtures/${variants[id] ?? (id === "app" ? app : id === "b" ? b : id)}.wasm`).bytes()])));
  const log: (number | string)[] = [];
  const environmentIds: symbol[] = [];
  const requires = (provider: string, fns: typeof calc[]) => ({ provider, interface: provider, version: 1,
    imports: fns.map((fn) => ({ ...fn, module: provider, provider_export: fn.name })) });
  const traceRequirement = { provider: "host.trace", interface: "host.trace", version: 1,
    imports: [{ ...trace, module: "trace", provider_export: "event" }] };
  const dependencies: Record<string, [string, typeof calc[]][]> = { core: [], b: [["core", [calc]]],
    a: [["b", [calc]], ["core", [calc]]], app: [["a", [calc, read]], ["b", [calc, read]], ["core", [read]]] };
  const ids = ["app", "a", "b", "core"];
  const modules = ids.map((id) => {
    const isApp = id === "app", exports = [...lifecycle, ...(isApp ? [signature("app_run", ["i32"], ["i32"])] : [calc, read])];
    const manifest = { schema_version: 1, kind: "wasm-module", id, role: isApp ? "app" : "lib",
      artifact: { path: `${id}.wasm`, sha256: hash(bytes[id]!) }, target: { abi: "wasip1", features: [] },
      interface: { name: id, version: 1 }, memory_model: "isolated", runtime_verification: "not-run",
      requires: [traceRequirement, ...dependencies[id]!.map(([provider, fns]) => requires(provider, fns))], exports };
    return { manifest, bytes: bytes[id]! };
  });
  const hosts = [{ id: "host.trace", interface: { name: "host.trace", version: 1 }, exports: [trace] }];
  const input = { modules, hosts };
  const numeric = ({ name, params, results }: typeof calc) => ({ name, params: [...params], results: [...results] });
  const options = { profile: "numeric-v1", modules: modules.map(({ manifest }) => ({ id: manifest.id,
    sha256: manifest.artifact.sha256, interface: manifest.interface, exports: manifest.role === "app" ? [] : [numeric(calc), numeric(read)] })),
    hosts: [{ id: hosts[0]!.id, interface: hosts[0]!.interface, exports: [numeric(trace)], create: (consumer: string, environmentId: symbol) => {
      environmentIds.push(environmentId);
      return { exports: { event: (value: number) => { log.push(value); onEvent?.(consumer, value); } },
        close: () => { log.push(`host:${consumer}`); } };
    } }], allowedFeatures: [], startupTimeoutMs: 30_000, executionTimeoutMs: 30_000,
    maxMemoryPages: 2, maxTotalMemoryPages: 8, maxTableElements: 0, maxTotalTableElements: 0 };
  return { input, options, log, environmentIds };
}

test("numeric DAG executes and closes in reverse dependency order", async () => {
  const { input, options, log, environmentIds } = await fixture();
  const environment = await loadNumericEnvironment(input, options);
  expect(environment.state).toBe("ready");
  expect(log).toEqual([12, 10, 22, 20, 32, 30, 42, 40]);
  expect(environment.run(5)).toBe(30);
  expect(new Set(environmentIds).size).toBe(1);
  environment.close();
  expect(environment.state).toBe("closed");
  expect(log.slice(0, 12)).toEqual([12, 10, 22, 20, 32, 30, 42, 40, 41, 31, 21, 11]);
  expect(log.slice(12).sort()).toEqual(["host:a", "host:app", "host:b", "host:core"].sort());
  expect(() => environment.close()).toThrow();
});

test("numeric module memories stay isolated across modules and environments", async () => {
  const first = await fixture(), second = await fixture();
  const [a, b] = await Promise.all([loadNumericEnvironment(first.input, first.options), loadNumericEnvironment(second.input, second.options)]);
  expect(first.environmentIds[0]).not.toBe(second.environmentIds[0]);
  expect(a.run(-2)).toBe(0);
  expect(b.run(-2)).toBe(0);
  expect(a.run(5)).toBe(30);
  expect(a.run(-2)).toBe(120);
  expect(b.run(-2)).toBe(0);
  expect(b.run(7)).toBe(40);
  expect(b.run(-2)).toBe(128);
  expect(a.run(-2)).toBe(120);
  a.close();
  b.close();
});

test("failed app initialization rolls back initialized providers and host resources", async () => {
  const { input, options, log } = await fixture("app-fail");
  await expect(loadNumericEnvironment(input, options)).rejects.toThrow("module_init returned 7");
  expect(log.slice(0, 11)).toEqual([12, 10, 22, 20, 32, 30, 42, 40, 31, 21, 11]);
  expect(log.slice(11).sort()).toEqual(["host:a", "host:app", "host:b", "host:core"].sort());
});

const failedLibraryTraces: Record<string, number[]> = { core: [12, 10], b: [12, 10, 22, 20, 11], a: [12, 10, 22, 20, 32, 30, 21, 11] };
for (const id of ["core", "b", "a"]) {
  test(`failed ${id} initialization rolls back only initialized providers`, async () => {
    const { input, options, log } = await fixture("app", undefined, "b", { [id]: `${id}-fail` });
    await expect(loadNumericEnvironment(input, options)).rejects.toThrow("module_init returned 7");
    expect(log.slice(0, failedLibraryTraces[id]!.length)).toEqual(failedLibraryTraces[id]!);
    expect(log.slice(failedLibraryTraces[id]!.length).sort()).toEqual(["host:a", "host:app", "host:b", "host:core"].sort());
  });
}

test("a guest trap poisons the entire environment and releases host resources", async () => {
  const { input, options, log } = await fixture();
  const environment = await loadNumericEnvironment(input, options);
  let first: unknown;
  try { environment.run(-1); } catch (error) { first = error; }
  expect(first).toBeInstanceOf(WebAssembly.RuntimeError);
  expect(environment.state).toBe("poisoned");
  expect(log.slice(0, 8)).toEqual([12, 10, 22, 20, 32, 30, 42, 40]);
  expect(log.slice(8).sort()).toEqual(["host:a", "host:app", "host:b", "host:core"].sort());
  expect(() => environment.run(5)).toThrow(first as Error);
  expect(() => environment.close()).toThrow(first as Error);
  expect(log).toHaveLength(12);
});

test("preflight rejects identity and resource violations before host creation", async () => {
  const identity = await fixture();
  identity.options.modules[0]!.sha256 = "0".repeat(64);
  await expect(loadNumericEnvironment(identity.input, identity.options)).rejects.toThrow("not authorized");
  expect(identity.log).toEqual([]);
  expect(identity.environmentIds).toEqual([]);
  const memory = await fixture();
  memory.options.maxTotalMemoryPages = 7;
  await expect(loadNumericEnvironment(memory.input, memory.options)).rejects.toThrow("resource limit exceeded");
  expect(memory.log).toEqual([]);
  expect(memory.environmentIds).toEqual([]);
});

test("abort during host creation releases all host instances before any guest entry", async () => {
  const { input, options, log, environmentIds } = await fixture();
  const controller = new AbortController();
  const create = options.hosts[0]!.create;
  options.hosts[0]!.create = (consumer, id) => { const host = create(consumer, id); controller.abort(); return host; };
  await expect(loadNumericEnvironment(input, { ...options, signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
  expect(environmentIds).toHaveLength(1);
  expect(log).toEqual(["host:core"]);
});

test("module bytes and trusted profile are snapshotted before asynchronous validation", async () => {
  const { input, options, log, environmentIds } = await fixture();
  const pending = loadNumericEnvironment(input, options);
  for (const item of input.modules) { item.bytes.fill(0); item.manifest.target.features.push("simd"); }
  options.allowedFeatures.push("simd");
  options.modules[0]!.sha256 = "0".repeat(64);
  options.hosts[0]!.create = () => { throw new Error("replacement host factory must not run"); };
  options.hosts[0]!.interface.version = 42;
  options.hosts[0]!.exports[0]!.params[0] = "i64";
  const environment = await pending;
  expect(environment.run(5)).toBe(30);
  expect(environmentIds).toHaveLength(4);
  expect(log).toEqual([12, 10, 22, 20, 32, 30, 42, 40]);
  environment.close();
});

test("a host Promise is rejected and no further guest lifecycle runs", async () => {
  const { input, options, log } = await fixture();
  const create = options.hosts[0]!.create;
  options.hosts[0]!.create = (consumer, id) => {
    const host = create(consumer, id), event = host.exports.event;
    return { ...host, exports: { event: (value: number) => { event(value); return Promise.resolve(); } } };
  };
  await expect(loadNumericEnvironment(input, options)).rejects.toThrow("invalid host result");
  expect(log[0]).toBe(12);
  expect(log.slice(1).sort()).toEqual(["host:a", "host:app", "host:b", "host:core"].sort());
});

test("caught reentrant execution still poisons the environment during close", async () => {
  let environment: Awaited<ReturnType<typeof loadNumericEnvironment>>;
  const { input, options, log } = await fixture("app", (_, value) => {
    if (value === 41) { try { environment.run(5); } catch { /* The outer call must retain the failure. */ } }
  });
  environment = await loadNumericEnvironment(input, options);
  expect(() => environment.close()).toThrow("not reentrant");
  expect(environment.state).toBe("poisoned");
  expect(log.slice(0, 9)).toEqual([12, 10, 22, 20, 32, 30, 42, 40, 41]);
  expect(log.slice(9).sort()).toEqual(["host:a", "host:app", "host:b", "host:core"].sort());
  expect(() => environment.run(5)).toThrow("not reentrant");
});

test("an invalid host factory result is still closed and preserves cleanup failures", async () => {
  const { input, options, log } = await fixture();
  const create = options.hosts[0]!.create;
  options.hosts[0]!.create = (consumer, id) => {
    const host = create(consumer, id);
    return { ...host, extra: true, close: () => { host.close(); throw new Error("host cleanup failed"); } };
  };
  let failure: unknown;
  try { await loadNumericEnvironment(input, options); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  const messages = (failure as AggregateError).errors.map((error: unknown) => String(error));
  expect(messages.some((value: string) => value.includes("unknown or missing fields"))).toBe(true);
  expect(messages.some((value: string) => value.includes("host cleanup failed"))).toBe(true);
  expect(log).toEqual(["host:core"]);
});

test("host errors during initialization stop subsequent guest calls", async () => {
  const duringInit = await fixture("app", (_, value) => { if (value === 40) throw new Error("init trap"); });
  await expect(loadNumericEnvironment(duringInit.input, duringInit.options)).rejects.toThrow("init trap");
  expect(duringInit.log.slice(0, 8)).toEqual([12, 10, 22, 20, 32, 30, 42, 40]);
  expect(duringInit.log.slice(8).sort()).toEqual(["host:a", "host:app", "host:b", "host:core"].sort());
});

test("host errors during close stop subsequent guest calls", async () => {
  const duringClose = await fixture("app", (_, value) => { if (value === 41) throw new Error("close trap"); });
  const environment = await loadNumericEnvironment(duringClose.input, duringClose.options);
  expect(() => environment.close()).toThrow("close trap");
  expect(environment.state).toBe("poisoned");
  expect(duringClose.log.slice(0, 9)).toEqual([12, 10, 22, 20, 32, 30, 42, 40, 41]);
  expect(duringClose.log.slice(9).sort()).toEqual(["host:a", "host:app", "host:b", "host:core"].sort());
});

test("reactor traps stop further guest calls and release host resources", async () => {
  const reactor = await fixture("app-reactor-trap");
  await expect(loadNumericEnvironment(reactor.input, reactor.options)).rejects.toBeInstanceOf(WebAssembly.RuntimeError);
  expect(reactor.log.slice(0, 7)).toEqual([12, 10, 22, 20, 32, 30, 42]);
  expect(reactor.log.slice(7).sort()).toEqual(["host:a", "host:app", "host:b", "host:core"].sort());
});

test("guest initialization traps stop further guest calls and release host resources", async () => {
  const duringInit = await fixture("app-init-trap");
  await expect(loadNumericEnvironment(duringInit.input, duringInit.options)).rejects.toBeInstanceOf(WebAssembly.RuntimeError);
  expect(duringInit.log.slice(0, 8)).toEqual([12, 10, 22, 20, 32, 30, 42, 40]);
  expect(duringInit.log.slice(8).sort()).toEqual(["host:a", "host:app", "host:b", "host:core"].sort());
});

test("guest close traps stop further guest calls and release host resources", async () => {
  const duringClose = await fixture("app-close-trap");
  const environment = await loadNumericEnvironment(duringClose.input, duringClose.options);
  expect(() => environment.close()).toThrow(WebAssembly.RuntimeError);
  expect(environment.state).toBe("poisoned");
  expect(duringClose.log.slice(0, 9)).toEqual([12, 10, 22, 20, 32, 30, 42, 40, 41]);
  expect(duringClose.log.slice(9).sort()).toEqual(["host:a", "host:app", "host:b", "host:core"].sort());
});

test("guest close failure stops further guest calls and releases host resources", async () => {
  const failedClose = await fixture("app-close-fail");
  const failed = await loadNumericEnvironment(failedClose.input, failedClose.options);
  expect(() => failed.close()).toThrow("module_close returned 7");
  expect(failed.state).toBe("poisoned");
  expect(failedClose.log.slice(0, 9)).toEqual([12, 10, 22, 20, 32, 30, 42, 40, 41]);
  expect(failedClose.log.slice(9).sort()).toEqual(["host:a", "host:app", "host:b", "host:core"].sort());
});

test("unapproved business functions and lifecycle imports fail before host creation", async () => {
  const unapproved = await fixture();
  unapproved.options.modules.find((item) => item.id === "core")!.exports = [numericRead()];
  await expect(loadNumericEnvironment(unapproved.input, unapproved.options)).rejects.toThrow("numeric import is not authorized");
  expect(unapproved.log).toEqual([]);
  expect(unapproved.environmentIds).toEqual([]);

  const reserved = await fixture("app", undefined, "b-reserved");
  const b = reserved.input.modules.find((item) => item.manifest.id === "b")!;
  const core = b.manifest.requires.find((item) => item.provider === "core")!;
  core.imports.push({ ...signature("module_init", [], ["i32"]), module: "core", provider_export: "module_init" });
  await expect(loadNumericEnvironment(reserved.input, reserved.options)).rejects.toThrow("unsupported numeric import");
  expect(reserved.log).toEqual([]);
  expect(reserved.environmentIds).toEqual([]);
});

function numericRead() { return { name: read.name, params: read.params, results: read.results }; }

test("shared numeric preflight checks real graphs without creating a host or instance", async () => {
  const cases = await Bun.file("target/validator/numeric-preflight.json").json() as any[];
  expect(cases.length).toBeGreaterThan(15);
  for (const item of cases) {
    let factories = 0;
    const input = { ...item.input, modules: item.input.modules.map((module: any) => ({
      manifest: module.manifest, bytes: new Uint8Array(Buffer.from(module.hex, "hex")),
    })) };
    const options = { profile: "numeric-v1", modules: item.profile.modules,
      hosts: item.profile.hosts.map((host: any) => ({ ...host, create: () => { factories++; throw new Error("factory must not run"); } })),
      ...item.profile.limits, allowedFeatures: item.allowedFeatures, startupTimeoutMs: 30_000, executionTimeoutMs: 30_000 };
    const check = () => { const graph = prepareModuleManifests(input); prepareNumericProfile(graph, options); compileNumericModules(graph); };
    if (item.pass) expect(check, item.name).not.toThrow();
    else expect(check, item.name).toThrow(item.error);
    expect(factories, item.name).toBe(0);
  }
});

test("unsupported numeric boundaries fail before any host factory or guest code", async () => {
  for (const variant of ["wasi", "start", "memory-import", "table-import", "unbounded", "f32", "v128", "import-init"]) {
    const coreVariant = variant === "memory-import" ? "core-export-memory" : variant === "table-import" ? "core-export-table"
      : variant === "f32" || variant === "v128" ? `core-${variant}` : "core";
    const { input, options, log, environmentIds } = await fixture(`app-${variant}`, undefined, "b", { core: coreVariant });
    const app = input.modules.find((item) => item.manifest.id === "app")!;
    const core = input.modules.find((item) => item.manifest.id === "core")!;
    const coreRequirement = app.manifest.requires.find((item) => item.provider === "core")!;
    if (variant === "wasi") {
      const fd = signature("fd_write", ["i32", "i32", "i32", "i32"], ["i32"]);
      input.hosts.push({ id: "host.wasi", interface: { name: "host.wasi", version: 1 }, exports: [fd] });
      options.hosts.push({ id: "host.wasi", interface: { name: "host.wasi", version: 1 },
        exports: [{ name: fd.name, params: fd.params, results: fd.results }],
        create: () => { log.push("unexpected-wasi-factory"); return { exports: { event: () => {} }, close: () => {} }; } });
      app.manifest.requires.push({ provider: "host.wasi", interface: "host.wasi", version: 1,
        imports: [{ ...fd, module: "wasi_snapshot_preview1", provider_export: "fd_write" }] });
    } else if (variant === "start") {
      app.manifest.exports.push(signature("_start", [], []));
    } else if (variant === "memory-import") {
      const memory = { name: "memory", kind: "memory", minimumPages: 1, maximumPages: 2, shared: false };
      core.manifest.exports.push(memory as any);
      coreRequirement.imports.push({ ...memory, module: "core", provider_export: "memory" } as any);
    } else if (variant === "table-import") {
      const table = { name: "table", kind: "table", element: "funcref", minimum: 1, maximum: 2 };
      core.manifest.exports.push(table as any);
      coreRequirement.imports.push({ ...table, module: "core", provider_export: "table" } as any);
      options.maxTableElements = 2;
      options.maxTotalTableElements = 4;
    } else if (variant === "f32" || variant === "v128") {
      const other = signature("other", [variant], [variant]);
      core.manifest.exports.push(other);
      coreRequirement.imports.push({ ...other, module: "core", provider_export: "other" });
      if (variant === "v128") {
        core.manifest.target.features.push("simd");
        app.manifest.target.features.push("simd");
        options.allowedFeatures.push("simd");
      }
    } else if (variant === "import-init") {
      coreRequirement.imports.push({ ...signature("module_init", [], ["i32"]), module: "core", provider_export: "module_init" });
    }
    const expected: Record<string, string> = { wasi: "WASI imports", start: "_start", "memory-import": "unsupported numeric import",
      "table-import": "unsupported numeric import", unbounded: "memory limit", f32: "numeric import is not authorized",
      v128: "numeric import is not authorized", "import-init": "must be an owned function" };
    await expect(loadNumericEnvironment(input, options)).rejects.toThrow(expected[variant]);
    expect(log).toEqual([]);
    expect(environmentIds).toEqual([]);
  }
});
