import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { inspectIsolatedResources } from "../bindings/typescript/src/index.ts";

const leb = (value: number): number[] => {
  const out: number[] = [];
  do { const byte = value % 128; value = Math.floor(value / 128); out.push(byte | (value ? 0x80 : 0)); } while (value);
  return out;
};
const text = (value: string): number[] => { const bytes = [...new TextEncoder().encode(value)]; return [...leb(bytes.length), ...bytes]; };
const vec = (...entries: number[][]): number[] => [...leb(entries.length), ...entries.flat()];
const section = (id: number, payload: number[]): number[] => [id, ...leb(payload.length), ...payload];
const wasm = (...sections: number[][]): Uint8Array => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, ...sections.flat()]);
const imported = (module: string, name: string, kind: number, ...type: number[]): number[] => [...text(module), ...text(name), kind, ...type];
const exported = (name: string, kind: number, index: number): number[] => [...text(name), kind, ...leb(index)];
const body = (...instructions: number[]): number[] => { const bytes = [0, ...instructions, 0x0b]; return [...leb(bytes.length), ...bytes]; };
const signature = (...parameters: number[]): number[] => [0x60, ...leb(parameters.length), ...parameters, 0];

test("reports owned resource topology without claiming runtime or pointer isolation", () => {
  const bytes = wasm(
    section(4, vec([0x70, 0, 1])), section(5, vec([0, 1])),
    section(7, vec(exported("memory", 2, 0), exported("memory-alias", 2, 0), exported("table", 1, 0))),
  );
  expect(WebAssembly.validate(bytes)).toBe(true);
  const result = inspectIsolatedResources(bytes);
  expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(result.memories).toBe(1);
  expect(result.tables).toBe(1);
  expect(result.usesWasi).toBe(false);
  expect(result.checks).toEqual({
    resourceTopology: "passed", engine: "passed", feature: "not-run", wasiAbi: "not-run",
    pointerContracts: "not-run", handleIsolation: "not-run", environmentIsolation: "not-run",
    hostImplementation: "not-run", lifecycle: "not-run",
  });
  const module = new WebAssembly.Module(bytes);
  const first = new WebAssembly.Instance(module), second = new WebAssembly.Instance(module);
  const a = first.exports.memory as WebAssembly.Memory, b = second.exports.memory as WebAssembly.Memory;
  expect(a).not.toBe(b);
  expect(first.exports["memory-alias"]).toBe(a);
  expect(first.exports.table).not.toBe(second.exports.table);
  new Uint8Array(a.buffer)[0] = 73;
  expect(new Uint8Array(b.buffer)[0]).toBe(0);
  a.grow(1);
  expect(b.buffer.byteLength).toBe(65_536);
});

test("rejects imported memories and tables even when they are not thread-shared", () => {
  const memory = wasm(section(2, vec(imported("env", "memory", 2, 0, 1))), section(7, vec(exported("memory", 2, 0))));
  const table = wasm(section(2, vec(imported("host", "table", 1, 0x70, 0, 1))), section(7, vec(exported("table", 1, 0))));
  expect(WebAssembly.validate(memory)).toBe(true);
  expect(WebAssembly.validate(table)).toBe(true);
  expect(() => inspectIsolatedResources(memory)).toThrow('import "env"."memory": isolated module cannot import memory');
  expect(() => inspectIsolatedResources(table)).toThrow('import "host"."table": isolated module cannot import table');
  const shared = new WebAssembly.Memory({ initial: 1 });
  const first = new WebAssembly.Instance(new WebAssembly.Module(memory), { env: { memory: shared } });
  const second = new WebAssembly.Instance(new WebAssembly.Module(memory), { env: { memory: shared } });
  expect(first.exports.memory).toBe(second.exports.memory);
});

test("rejects shared and multiple resources before engine compilation", () => {
  const shared = wasm(section(5, vec([3, 1, 2])));
  const multipleMemories = wasm(section(5, vec([0, 1], [0, 1])));
  const multipleTables = wasm(section(4, vec([0x70, 0, 1], [0x70, 0, 1])));
  expect(() => inspectIsolatedResources(shared)).toThrow("cannot have shared memory");
  expect(() => inspectIsolatedResources(multipleMemories)).toThrow("cannot have multiple memories");
  expect(() => inspectIsolatedResources(multipleTables)).toThrow("cannot have multiple tables");
});

test("rejects start sections without invoking guest or host code", () => {
  const bytes = wasm(
    section(1, vec(signature())), section(2, vec(imported("env", "start", 0, 0))),
    section(5, vec([0, 1])), section(7, vec(exported("memory", 2, 0))), section(8, [0]),
  );
  let calls = 0;
  expect(WebAssembly.validate(bytes)).toBe(true);
  expect(() => inspectIsolatedResources(bytes)).toThrow("cannot have a start section");
  expect(calls).toBe(0);
  let memory: WebAssembly.Memory | undefined;
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { start() { expect(memory).toBeUndefined(); calls++; } } });
  memory = instance.exports.memory as WebAssembly.Memory;
  expect(calls).toBe(1);
  expect(memory).toBeInstanceOf(WebAssembly.Memory);
});

test("rejects reference types in cross-instance functions and tags", () => {
  for (const value of [0x70, 0x6f]) {
    const functionImport = wasm(section(1, vec(signature(value))), section(2, vec(imported("env", "callback", 0, 0))));
    const functionExport = wasm(section(1, vec(signature(value))), section(3, vec([0])), section(7, vec(exported("callback", 0, 0))), section(10, vec(body())));
    const tagImport = wasm(section(1, vec(signature(value))), section(2, vec(imported("env", "event", 4, 0, 0))));
    const tagExport = wasm(section(1, vec(signature(value))), section(13, vec([0, 0])), section(7, vec(exported("event", 4, 0))));
    for (const bytes of [functionImport, functionExport, tagImport, tagExport]) {
      expect(WebAssembly.validate(bytes)).toBe(true);
      expect(() => inspectIsolatedResources(bytes)).toThrow("reference-typed function or tag");
    }
  }
  const localTable = wasm(section(4, vec([0x70, 0, 1])));
  expect(inspectIsolatedResources(localTable).tables).toBe(1);
});

test("only immutable numeric imported globals are accepted", () => {
  const global = (type: number, mutable: number) => wasm(section(2, vec(imported("env", "global", 3, type, mutable))));
  expect(inspectIsolatedResources(global(0x7f, 0)).checks.resourceTopology).toBe("passed");
  for (const bytes of [global(0x7f, 1), global(0x70, 0), global(0x6f, 0)]) {
    expect(WebAssembly.validate(bytes)).toBe(true);
    expect(() => inspectIsolatedResources(bytes)).toThrow("mutable or reference-typed globals");
  }
});

test("reuses signature facts across repeated imports", () => {
  const parameterCount = 1_000;
  const entries = new Array(300).fill(null).map(() => imported("env", "callback", 0, 0));
  const bytes = wasm(section(1, vec(signature(...new Array(parameterCount).fill(0x7f)))), section(2, vec(...entries)));
  expect(WebAssembly.validate(bytes)).toBe(true);
  expect(inspectIsolatedResources(bytes).checks.resourceTopology).toBe("passed");
});

test("WASI imports require the module's own memory exported as memory", () => {
  const types = section(1, vec(signature()));
  const imports = section(2, vec(imported("wasi_snapshot_preview1", "fd_write", 0, 0)));
  const memory = section(5, vec([0, 1]));
  const exportedMemory = section(7, vec(exported("memory", 2, 0), exported("other", 2, 0)));
  for (const bytes of [wasm(types, imports), wasm(types, imports, memory), wasm(types, imports, memory, section(7, vec(exported("other", 2, 0))))]) {
    expect(WebAssembly.validate(bytes)).toBe(true);
    expect(() => inspectIsolatedResources(bytes)).toThrow("must export its own memory as memory");
  }
  const result = inspectIsolatedResources(wasm(types, imports, memory, exportedMemory));
  expect(result.usesWasi).toBe(true);
  expect(result.checks.wasiAbi).toBe("not-run");
});

test("requires actual code validation and snapshots the true input range", () => {
  const invalid = wasm(section(1, vec(signature())), section(3, vec([0])), section(10, vec([2, 0, 0])));
  expect(WebAssembly.validate(invalid)).toBe(false);
  expect(() => inspectIsolatedResources(invalid)).toThrow("current engine compilation failed");
  const empty = wasm();
  const storage = new Uint8Array(empty.length + 4);
  storage.set(empty, 2);
  const view = storage.subarray(2, -2);
  Object.defineProperty(view, "buffer", { value: invalid.buffer });
  expect(inspectIsolatedResources(view).sha256).toBe(createHash("sha256").update(empty).digest("hex"));
});

test("the default core has an isolated resource topology", async () => {
  const bytes = await Bun.file("target/wasm/liblvgl.wasm").arrayBuffer();
  const result = inspectIsolatedResources(bytes);
  expect(result.memories).toBe(1);
  expect(result.tables).toBe(1);
  expect(result.usesWasi).toBe(true);
  expect(result.checks.resourceTopology).toBe("passed");
});
