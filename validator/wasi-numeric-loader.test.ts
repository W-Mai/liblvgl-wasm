import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, test as bunTest } from "bun:test";
import { loadNumericEnvironment as loadEnvironment, NumericWasiExit } from "../target/validator/feature-validator.js";

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
      timer = setTimeout(() => reject(new Error("numeric WASI test cleanup timed out")), 10_000);
    })]);
  } catch (error) { errors.push(error); } finally { clearTimeout(timer); }
  for (const environment of context.environments) {
    if (environment.state !== "ready") continue;
    try { environment.close(); } catch (error) { errors.push(error); }
  }
  context.environments.clear();
  errors.push(...context.cleanupErrors);
  if (errors.length) throw new AggregateError(errors, "numeric WASI test cleanup failed");
}, 30_000);

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const signature = (name: string, params: string[], results: string[]) => ({ name, kind: "function", params, results });
const services = [signature("fd_write", ["i32", "i32", "i32", "i32"], ["i32"]),
  signature("fd_close", ["i32"], ["i32"]), signature("fd_seek", ["i32", "i64", "i32", "i32"], ["i32"]),
  signature("environ_get", ["i32", "i32"], ["i32"]), signature("environ_sizes_get", ["i32", "i32"], ["i32"]),
  signature("clock_time_get", ["i32", "i64", "i32"], ["i32"]), signature("proc_exit", ["i32"], [])];
const entrypoints = [signature("_initialize", [], []), signature("module_init", [], ["i32"]), signature("module_close", [], ["i32"])];
const invoke = signature("invoke", ["i32"], ["i32"]);

async function fixture(c = false, app = "app", trace = false, badSignature = false) {
  const ids = c ? ["app"] : ["app", "lib"];
  const files = Object.fromEntries(await Promise.all(ids.map(async (id) => [id,
    await Bun.file(`target/validator/wasi-numeric-fixtures/${c ? "c-app" : badSignature ? `${id}-bad-signature` : trace ? `${id}-trace` : id === "app" ? app : id}.wasm`).bytes()])));
  const iface = { name: "wasi", version: 1 };
  const wasiFunctions = services.map((item) => ({ ...item, params: [...item.params], results: [...item.results] }));
  const modules = ids.map((id) => {
    const isApp = id === "app", actual = c ? wasiFunctions.filter((item) => item.name === "fd_write") : wasiFunctions;
    const imports = actual.map((item) => ({ ...item, module: "wasi_snapshot_preview1", provider_export: item.name }));
    const requires = [{ provider: "host.wasi", interface: "wasi", version: 1, imports }];
    if (trace) requires.push({ provider: "host.trace", interface: "trace", version: 1,
      imports: [{ ...signature("touch", ["i32"], []), module: "trace", provider_export: "touch" }] });
    if (!c && isApp) requires.push({ provider: "lib", interface: "lib", version: 1,
      imports: [{ ...invoke, module: "lib", provider_export: "invoke" }] });
    const memory = { name: "memory", kind: "memory", minimumPages: c ? 2 : 1, maximumPages: c ? 4 : 2, shared: false };
    const exports = [...entrypoints, memory, isApp ? signature("app_run", ["i32"], ["i32"]) : invoke];
    const manifest = { schema_version: 1, kind: "wasm-module", id, role: isApp ? "app" : "lib",
      artifact: { path: `${id}.wasm`, sha256: hash(files[id]!) }, target: { abi: "wasip1", features: [] },
      interface: { name: id, version: 1 }, memory_model: "isolated", requires, exports, runtime_verification: "not-run" };
    return { manifest, bytes: files[id]! };
  });
  const writes: { consumer: string; fd: number; bytes: Uint8Array; environmentId: symbol }[] = [];
  const hostIds: { consumer: string; environmentId: symbol }[] = [];
  const input = { modules, hosts: [{ id: "host.wasi", interface: iface, exports: wasiFunctions }] };
  const options = { profile: "numeric-v1", modules: modules.map(({ manifest }) => ({ id: manifest.id,
    sha256: manifest.artifact.sha256, interface: manifest.interface, exports: manifest.role === "lib"
      ? [{ name: invoke.name, params: [...invoke.params], results: [...invoke.results] }] : [] })), hosts: [],
    wasi: { id: "host.wasi", interface: { ...iface }, allowed: wasiFunctions.map((item) => item.name), outputFds: [1, 2],
      maxIovecs: 4, maxWriteBytes: 32, maxOutputBytes: 128, clock: { realtimeNs: 123n, monotonicNs: 456n },
      onWrite: (consumer: string, fd: number, bytes: Uint8Array, environmentId: symbol) => { writes.push({ consumer, fd, bytes, environmentId }); } },
    allowedFeatures: [], startupTimeoutMs: 30_000, executionTimeoutMs: 30_000,
    maxMemoryPages: 4, maxTotalMemoryPages: 8, maxTableElements: c ? 1 : 0, maxTotalTableElements: c ? 1 : 0 };
  if (trace) {
    const touch = signature("touch", ["i32"], []);
    input.hosts.push({ id: "host.trace", interface: { name: "trace", version: 1 }, exports: [touch] });
    options.hosts.push({ id: "host.trace", interface: { name: "trace", version: 1 },
      exports: [{ name: "touch", params: ["i32"], results: [] }],
      create: (consumer: string, environmentId: symbol) => { hostIds.push({ consumer, environmentId });
        return { exports: { touch: (_value: number) => {} }, close: () => {} }; } });
  }
  return { input, options, writes, hostIds };
}

function messages(writes: { consumer: string; fd: number; bytes: Uint8Array }[]) {
  const decoder = new TextDecoder();
  return writes.map(({ consumer, fd, bytes }) => [consumer, fd, decoder.decode(bytes)]);
}

test("two consumers use independent WASI memory, descriptors and environment state", async () => {
  const first = await fixture(), second = await fixture();
  const a = await loadNumericEnvironment(first.input, first.options);
  const b = await loadNumericEnvironment(second.input, second.options);
  try {
    expect(messages(first.writes)).toEqual([["lib", 2, "init"], ["app", 2, "init"]]);
    expect(messages(second.writes)).toEqual([["lib", 2, "init"], ["app", 2, "init"]]);
    expect(a.run(0)).toBe(0);
    expect(a.run(100)).toBe(0);
    expect(b.run(100)).toBe(0);
    expect(a.run(8)).toBe(0);
    expect(a.run(108)).toBe(0);
    expect(a.run(11)).toBe(123);
    expect(a.run(111)).toBe(123);
    expect(b.run(11)).toBe(123);
    expect(a.run(9)).toBe(0);
    expect(a.run(10)).toBe(0);
    expect(a.run(12)).toBe(70);
    expect(a.run(13)).toBe(0);
    expect(a.run(0)).toBe(8);
    expect(a.run(100)).toBe(0);
    expect(b.run(0)).toBe(0);
    expect(messages(first.writes)).toEqual([["lib", 2, "init"], ["app", 2, "init"],
      ["app", 1, "APP!"], ["lib", 1, "LIB!"], ["app", 1, "GROW"], ["lib", 1, "GROW"], ["lib", 1, "LIB!"]]);
    expect(messages(second.writes)).toEqual([["lib", 2, "init"], ["app", 2, "init"], ["lib", 1, "LIB!"], ["app", 1, "APP!"]]);
  } finally {
    if (a.state === "ready") a.close();
    if (b.state === "ready") b.close();
  }
  expect(a.state).toBe("closed");
  expect(messages(first.writes).slice(-2)).toEqual([["app", 2, "done"], ["lib", 2, "done"]]);
  expect(messages(second.writes).slice(-2)).toEqual([["app", 2, "done"], ["lib", 2, "done"]]);
});

test("a shared sink receives a unique environment identity for each isolated environment", async () => {
  const first = await fixture(false, "app", true), second = await fixture(false, "app", true);
  const records: { consumer: string; environmentId: symbol }[] = [];
  const sink = (consumer: string, _fd: number, _bytes: Uint8Array, environmentId: symbol) => { records.push({ consumer, environmentId }); };
  first.options.wasi.onWrite = sink;
  second.options.wasi.onWrite = sink;
  const a = await loadNumericEnvironment(first.input, first.options);
  const b = await loadNumericEnvironment(second.input, second.options);
  try {
    expect(a.run(0)).toBe(0);
    expect(b.run(100)).toBe(0);
    expect(records.map((item) => item.consumer)).toEqual(["lib", "app", "lib", "app", "app", "lib"]);
    const firstId = records[0]!.environmentId, secondId = records[2]!.environmentId;
    expect(typeof firstId).toBe("symbol");
    expect(typeof secondId).toBe("symbol");
    expect(firstId).not.toBe(secondId);
    expect(first.hostIds).toEqual([{ consumer: "lib", environmentId: firstId }, { consumer: "app", environmentId: firstId }]);
    expect(second.hostIds).toEqual([{ consumer: "lib", environmentId: secondId }, { consumer: "app", environmentId: secondId }]);
    expect(records[1]!.environmentId).toBe(firstId);
    expect(records[4]!.environmentId).toBe(firstId);
    expect(records[3]!.environmentId).toBe(secondId);
    expect(records[5]!.environmentId).toBe(secondId);
  } finally {
    if (a.state === "ready") a.close();
    if (b.state === "ready") b.close();
  }
});

test("malformed iovecs and invalid fds do not emit output", async () => {
  const { input, options, writes } = await fixture();
  const environment = await loadNumericEnvironment(input, options);
  try {
    for (const [opcode, result] of [[1, 21], [2, 28], [3, 21], [4, 21], [5, 21], [6, 8], [7, 0], [17, 58]]) {
      expect(environment.run(opcode)).toBe(result);
      expect(environment.run(opcode + 100)).toBe(result);
    }
    expect(messages(writes)).toEqual([["lib", 2, "init"], ["app", 2, "init"]]);
    expect(environment.run(16)).toBe(0);
    expect(messages(writes).at(-1)).toEqual(["app", 1, "APP!"]);
  } finally { if (environment.state === "ready") environment.close(); }
});

test("output quota is shared only inside one environment", async () => {
  const first = await fixture(), second = await fixture();
  first.options.wasi.maxOutputBytes = 12;
  second.options.wasi.maxOutputBytes = 12;
  const a = await loadNumericEnvironment(first.input, first.options);
  const b = await loadNumericEnvironment(second.input, second.options);
  try {
    expect(a.run(0)).toBe(0);
    expect(a.run(100)).toBe(51);
    expect(b.run(100)).toBe(0);
    expect(messages(first.writes).slice(2)).toEqual([["app", 1, "APP!"]]);
    expect(messages(second.writes).slice(2)).toEqual([["lib", 1, "LIB!"]]);
  } finally {
    if (a.state === "ready") a.close();
    if (b.state === "ready") b.close();
  }
});

test("WASI service and descriptor permissions are enforced before guest execution", async () => {
  const denied = await fixture();
  denied.options.wasi.allowed = denied.options.wasi.allowed.filter((name) => name !== "fd_write");
  await expect(loadNumericEnvironment(denied.input, denied.options)).rejects.toThrow();
  expect(denied.writes).toEqual([]);
  const missing = await fixture();
  const { wasi: _, ...withoutWasi } = missing.options;
  await expect(loadNumericEnvironment(missing.input, withoutWasi)).rejects.toThrow();
  expect(missing.writes).toEqual([]);
  const badProvider = await fixture();
  badProvider.options.wasi.interface.version = 2;
  await expect(loadNumericEnvironment(badProvider.input, badProvider.options)).rejects.toThrow();
  expect(badProvider.writes).toEqual([]);
  const remapped = await fixture();
  const requirement = remapped.input.modules[0]!.manifest.requires[0]!;
  requirement.imports.find((item) => item.name === "environ_get")!.provider_export = "environ_sizes_get";
  await expect(loadNumericEnvironment(remapped.input, remapped.options)).rejects.toThrow();
  expect(remapped.writes).toEqual([]);
  const renamed = await fixture(false, "app-alias");
  renamed.input.modules[0]!.manifest.requires[0]!.imports.find((item) => item.name === "fd_write")!.module = "fakewasi";
  await expect(loadNumericEnvironment(renamed.input, renamed.options)).rejects.toThrow();
  expect(renamed.writes).toEqual([]);
  const badSignature = await fixture(false, "app", true, true);
  badSignature.input.hosts[0]!.exports.find((item) => item.name === "fd_write")!.params = ["i32", "i32", "i32"];
  for (const item of badSignature.input.modules) {
    item.manifest.requires[0]!.imports.find((entry) => entry.name === "fd_write")!.params = ["i32", "i32", "i32"];
  }
  await expect(loadNumericEnvironment(badSignature.input, badSignature.options)).rejects.toThrow("WASI");
  expect(badSignature.hostIds).toEqual([]);
  expect(badSignature.writes).toEqual([]);
  const stdout = await fixture();
  stdout.options.wasi.outputFds = [2];
  const environment = await loadNumericEnvironment(stdout.input, stdout.options);
  try {
    expect(environment.run(0)).toBe(8);
    expect(environment.run(100)).toBe(8);
    expect(environment.run(15)).toBe(0);
    expect(messages(stdout.writes)).toEqual([["lib", 2, "init"], ["app", 2, "init"], ["app", 2, "APP!"]]);
  } finally { if (environment.state === "ready") environment.close(); }
});

test("caller changes after admission do not replace the captured WASI policy or sink", async () => {
  const { input, options, writes } = await fixture();
  const pending = loadNumericEnvironment(input, options);
  options.wasi.allowed.length = 0;
  options.wasi.outputFds.length = 0;
  options.wasi.clock.realtimeNs = 777n;
  options.wasi.onWrite = () => { throw new Error("replacement sink must not run"); };
  for (const module of input.modules) module.bytes.fill(0);
  const environment = await pending;
  try {
    expect(environment.run(0)).toBe(0);
    expect(environment.run(100)).toBe(0);
    expect(environment.run(11)).toBe(123);
    expect(messages(writes)).toEqual([["lib", 2, "init"], ["app", 2, "init"], ["app", 1, "APP!"], ["lib", 1, "LIB!"]]);
  } finally { if (environment.state === "ready") environment.close(); }
});

test("proc_exit and output sink failures poison without entering other guest cleanup", async () => {
  const exit = await fixture();
  const environment = await loadNumericEnvironment(exit.input, exit.options);
  let failure: unknown;
  try { environment.run(14); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(NumericWasiExit);
  expect(failure).toMatchObject({ code: 42 });
  expect(environment.state).toBe("poisoned");
  expect(() => environment.run(100)).toThrow(failure as Error);
  expect(() => environment.close()).toThrow(failure as Error);
  expect(messages(exit.writes)).toEqual([["lib", 2, "init"], ["app", 2, "init"]]);

  const sink = await fixture();
  const original = sink.options.wasi.onWrite;
  sink.options.wasi.onWrite = (consumer, fd, bytes, id) => { if (fd === 1) throw new Error("sink failure"); original(consumer, fd, bytes, id); };
  const poisoned = await loadNumericEnvironment(sink.input, sink.options);
  expect(() => poisoned.run(0)).toThrow("sink failure");
  expect(poisoned.state).toBe("poisoned");
  expect(() => poisoned.run(100)).toThrow("sink failure");
  expect(messages(sink.writes)).toEqual([["lib", 2, "init"], ["app", 2, "init"]]);
});

test("a caught WASI sink reentry still poisons the environment", async () => {
  const { input, options, writes } = await fixture();
  const original = options.wasi.onWrite;
  let environment: Awaited<ReturnType<typeof loadNumericEnvironment>>;
  options.wasi.onWrite = (consumer, fd, bytes, id) => {
    if (fd === 1) { try { environment.run(100); } catch { /* The outer WASI call must retain the failure. */ } }
    original(consumer, fd, bytes, id);
  };
  environment = await loadNumericEnvironment(input, options);
  expect(() => environment.run(0)).toThrow("not reentrant");
  expect(environment.state).toBe("poisoned");
  expect(() => environment.run(100)).toThrow("not reentrant");
  expect(messages(writes)).toEqual([["lib", 2, "init"], ["app", 2, "init"], ["app", 1, "APP!"]]);
});

test("a WASI SDK C reactor writes through libc", async () => {
  const { input, options, writes } = await fixture(true);
  const environment = await loadNumericEnvironment(input, options);
  try {
    expect(environment.run(5)).toBe(6);
    expect(messages(writes)).toEqual([["app", 2, "ci"], ["app", 1, "C!"]]);
  } finally { if (environment.state === "ready") environment.close(); }
  expect(messages(writes).at(-1)).toEqual(["app", 2, "ce"]);
});
