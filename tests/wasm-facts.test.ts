import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { inspectWasmFacts, WASM_FACTS_LIMITS } from "../bindings/typescript/src/index.ts";
import sharedCases from "./fixtures/wasm-facts/cases.json";
import expectedFacts from "./fixtures/wasm-facts/expected.json";

const leb = (n: number): number[] => {
  const bytes = [];
  do { const part = n & 0x7f; n = Math.floor(n / 128); bytes.push(part | (n ? 0x80 : 0)); } while (n);
  return bytes;
};
const vec = (...entries: number[][]): number[] => [...leb(entries.length), ...entries.flat()];
const name = (value: string): number[] => { const bytes = [...new TextEncoder().encode(value)]; return [...leb(bytes.length), ...bytes]; };
const section = (id: number, bytes: number[]): number[] => [id, ...leb(bytes.length), ...bytes];
const wasm = (...sections: number[][]): Uint8Array => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, ...sections.flat()]);
const entry = (module: string, name_: string, kind: number, ...type: number[]): number[] => [...name(module), ...name(name_), kind, ...type];
const exported = (name_: string, kind: number, index: number): number[] => [...name(name_), kind, ...leb(index)];

function mixedModule(): Uint8Array {
  return fixtureBytes(sharedCases.find((item) => item.name === "mixed")!);
}

function fixtureBytes(item: typeof sharedCases[number]): Uint8Array {
  if (item.hex !== undefined) return Uint8Array.from(item.hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  const count = item.count!;
  let payload: Uint8Array, id: number;
  if (item.recipe === "parameters") {
    const prefix = [1, 0x60, ...leb(count)];
    payload = new Uint8Array(prefix.length + count + 1);
    payload.set(prefix);
    payload.fill(0x7f, prefix.length, prefix.length + count);
    id = 1;
  } else if (item.recipe === "cumulative-parameters") {
    const prefix = [0x60, ...leb(count)];
    const size = prefix.length + count + 1;
    payload = new Uint8Array(1 + 2 * size);
    payload[0] = 2;
    for (const offset of [1, 1 + size]) {
      payload.set(prefix, offset);
      payload.fill(0x7f, offset + prefix.length, offset + prefix.length + count);
    }
    id = 1;
  } else if (item.recipe === "name") {
    const prefix = leb(count);
    payload = new Uint8Array(prefix.length + count);
    payload.set(prefix);
    payload.fill(0x61, prefix.length);
    id = 0;
  } else if (item.recipe === "sections") {
    const result = new Uint8Array(8 + count * 3);
    result.set([0, 97, 115, 109, 1, 0, 0, 0]);
    for (let i = 0; i < count; i++) result.set([0, 1, 0], 8 + i * 3);
    return result;
  } else if (item.recipe === "cumulative-names") {
    const prefix = leb(count);
    const size = 1 + leb(prefix.length + count).length + prefix.length + count;
    const result = new Uint8Array(8 + 2 * size);
    result.set([0, 97, 115, 109, 1, 0, 0, 0]);
    for (const offset of [8, 8 + size]) {
      const header = [0, ...leb(prefix.length + count), ...prefix];
      result.set(header, offset);
      result.fill(0x61, offset + header.length, offset + size);
    }
    return result;
  } else if (item.recipe === "input") {
    const result = new Uint8Array(count);
    result.set([0, 97, 115, 109, 1, 0, 0, 0]);
    let payloadLength = count - 9;
    while (payloadLength + leb(payloadLength).length !== count - 9) payloadLength--;
    result.set([0, ...leb(payloadLength), 0], 8);
    return result;
  } else throw new Error(`unknown fixture recipe: ${item.recipe}`);
  const prefix = [0, 97, 115, 109, 1, 0, 0, 0, id, ...leb(payload.length)];
  const result = new Uint8Array(prefix.length + payload.length);
  result.set(prefix);
  result.set(payload, prefix.length);
  return result;
}

for (const fixture of sharedCases) {
  test(`shared Wasm facts: ${fixture.name}`, () => {
    const bytes = fixtureBytes(fixture);
    if (fixture.accepted) {
      const facts = inspectWasmFacts(bytes);
      expect(facts.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(facts.validation).toBe("not-run");
      expect(facts.featureDetection).toBe("not-run");
      expect(facts.abiDetection).toBe("not-run");
      if (fixture.name in expectedFacts) expect(facts).toEqual(expectedFacts[fixture.name as keyof typeof expectedFacts]);
      if (fixture.recipe === "parameters") expect(facts.types[0]!.params).toHaveLength(fixture.count!);
    } else if (fixture.limit !== undefined) {
      expect(() => inspectWasmFacts(bytes)).toThrow(`Wasm facts inspection limit: ${fixture.limit}`);
    } else expect(() => inspectWasmFacts(bytes)).toThrow();
    if (fixture.engineValid !== undefined) expect(WebAssembly.validate(bytes)).toBe(fixture.engineValid);
  }, 30_000);
}

test("facts retain binary identity, mixed index spaces and duplicate imports", () => {
  const binary = mixedModule();
  expect(WebAssembly.validate(binary)).toBe(true);
  const compiled = new WebAssembly.Module(binary);
  const wrapped = new Uint8Array(binary.length + 4);
  wrapped.set(binary, 2);
  const facts = inspectWasmFacts(wrapped.subarray(2, -2));
  expect(facts.sha256).toBe(createHash("sha256").update(binary).digest("hex"));
  expect(facts.validation).toBe("not-run");
  expect(facts.featureDetection).toBe("not-run");
  expect(facts.abiDetection).toBe("not-run");
  expect(facts.imports.map(({ module, name, kind }) => ({ module, name, kind }))).toEqual(WebAssembly.Module.imports(compiled).map(({ module, name, kind }) => ({ module, name, kind })));
  expect(facts.exports.map(({ name, kind }) => ({ name, kind }))).toEqual(WebAssembly.Module.exports(compiled).map(({ name, kind }) => ({ name, kind })));
  expect(facts.types).toEqual([{ params: ["i32"], results: ["i32"] }, { params: [], results: [] }]);
  expect(facts.imports[0]).toEqual({ module: "env", name: "same", kind: "function", index: 0, typeIndex: 0 });
  expect(facts.imports[1]).toEqual({ module: "env", name: "same", kind: "function", index: 1, typeIndex: 1 });
  expect(facts.imports[2]).toEqual({ module: "env", name: "table", kind: "table", index: 0, type: { element: "funcref", minimum: 1, maximum: 3 } });
  expect(facts.imports[3]).toEqual({ module: "env", name: "memory", kind: "memory", index: 0, type: { minimumPages: 1, maximumPages: 2, shared: false } });
  expect(facts.imports[4]).toEqual({ module: "\ufeffenv", name: "global", kind: "global", index: 0, type: { value: "i32", mutable: false } });
  expect(facts.exports[4]).toEqual({ name: "other-table", kind: "table", index: 1, type: { element: "externref", minimum: 0, maximum: null } });
  expect(facts.exports[7]).toEqual({ name: "other-global", kind: "global", index: 1, type: { value: "i64", mutable: true } });
  expect(facts.start).toEqual({ index: 2, typeIndex: 1 });
  expect(facts.functions[3]).toEqual({ index: 3, imported: false, typeIndex: 1 });
  expect(facts.tables[2]).toEqual({ index: 2, imported: false, type: { element: "funcref", minimum: 0, maximum: null } });
  expect(facts.globals[2]).toEqual({ index: 2, imported: false, type: { value: "i32", mutable: false } });
  wrapped.fill(0);
  expect(facts.sha256).toBe(createHash("sha256").update(binary).digest("hex"));
});

test("snapshot uses buffer and view internal slots despite shadowed properties", () => {
  const binary = mixedModule();
  const backing = new Uint8Array(binary.length + 8);
  backing.set(binary, 4);
  const other = wasm();
  const expected = createHash("sha256").update(binary).digest("hex");
  for (const view of [new Uint8Array(backing.buffer, 4, binary.length), new DataView(backing.buffer, 4, binary.length)]) {
    Object.defineProperties(view, {
      buffer: { value: other.buffer }, byteOffset: { value: 0 }, byteLength: { value: other.byteLength },
    });
    expect(inspectWasmFacts(view).sha256).toBe(expected);
  }
  const oversized = new ArrayBuffer(WASM_FACTS_LIMITS.inputBytes + 1);
  Object.defineProperty(oversized, "byteLength", { value: 8 });
  expect(() => inspectWasmFacts(oversized)).toThrow("inspection limit: input bytes");
  for (const view of [new Uint8Array(oversized), new DataView(oversized)]) {
    Object.defineProperties(view, {
      buffer: { value: other.buffer }, byteOffset: { value: 0 }, byteLength: { value: 8 },
    });
    expect(() => inspectWasmFacts(view)).toThrow("inspection limit: input bytes");
  }
});

test("facts include an unexported shared memory", () => {
  const bytes = wasm(section(5, vec([3, 0, 2])));
  expect(WebAssembly.validate(bytes)).toBe(true);
  expect(inspectWasmFacts(bytes).memories).toEqual([
    { index: 0, imported: false, type: { minimumPages: 0, maximumPages: 2, shared: true } },
  ]);
});

test("memory imports and definitions share one index space", () => {
  const bytes = wasm(
    section(2, vec(entry("env", "first", 2, 0, 0), entry("env", "second", 2, 1, 1, 4))),
    section(5, vec([3, 0, 2])),
    section(7, vec(exported("defined", 2, 2))),
  );
  const facts = inspectWasmFacts(bytes);
  expect(facts.memories).toEqual([
    { index: 0, imported: true, type: { minimumPages: 0, maximumPages: null, shared: false } },
    { index: 1, imported: true, type: { minimumPages: 1, maximumPages: 4, shared: false } },
    { index: 2, imported: false, type: { minimumPages: 0, maximumPages: 2, shared: true } },
  ]);
  expect(facts.exports[0]).toEqual({ name: "defined", kind: "memory", index: 2, type: facts.memories[2]!.type });
});

test("tag imports, definitions and exports use their own index space", () => {
  const bytes = wasm(
    section(1, vec([0x60, 1, 0x7f, 0])),
    section(2, vec(entry("env", "tag", 4, 0, 0))),
    section(13, vec([0, 0])),
    section(7, vec(exported("imported-tag", 4, 0), exported("defined-tag", 4, 1))),
  );
  expect(WebAssembly.validate(bytes)).toBe(true);
  const facts = inspectWasmFacts(bytes);
  expect(facts.types[0]).toEqual({ params: ["i32"], results: [] });
  expect(facts.imports[0]).toEqual({ module: "env", name: "tag", kind: "tag", index: 0, typeIndex: 0 });
  expect(facts.exports[1]).toEqual({ name: "defined-tag", kind: "tag", index: 1, typeIndex: 0 });
  expect(facts.tags).toEqual([
    { index: 0, imported: true, typeIndex: 0 },
    { index: 1, imported: false, typeIndex: 0 },
  ]);
});

test("repeated signatures remain references when facts are serialized", () => {
  const imports = new Array(3_000).fill(entry("m", "f", 0, 0));
  const bytes = wasm(section(1, vec([0x60, ...leb(200), ...new Array(200).fill(0x7f), 0])), section(2, vec(...imports)));
  const facts = inspectWasmFacts(bytes);
  expect(facts.types[0]!.params).toHaveLength(200);
  expect(facts.imports).toHaveLength(3_000);
  expect(JSON.stringify(facts).length).toBeLessThan(500_000);
});

test("reader applies cumulative inspection limits before large allocations", () => {
  const max = WASM_FACTS_LIMITS.vectorElements;
  const manyTypes = (count: number) => wasm(section(1, [...leb(count), ...new Array(count).fill([0x60, 0, 0]).flat()]));
  const supported = manyTypes(10_000);
  expect(WebAssembly.validate(supported)).toBe(true);
  expect(inspectWasmFacts(supported).functions).toEqual([]);
  expect(() => inspectWasmFacts(manyTypes(max + 1))).toThrow("inspection limit: vector elements");
  const params = (count: number) => [0x60, ...leb(count), ...new Array(count).fill(0x7f), 0];
  const cumulative = wasm(section(1, vec(params(25_000), params(25_000))));
  expect(() => inspectWasmFacts(cumulative)).toThrow("inspection limit: vector elements");
  const tooManySections = wasm(...new Array(WASM_FACTS_LIMITS.sections + 1).fill([0, 1, 0]));
  expect(() => inspectWasmFacts(tooManySections)).toThrow("inspection limit: sections");
  expect(() => inspectWasmFacts(new Uint8Array(WASM_FACTS_LIMITS.inputBytes + 1))).toThrow("inspection limit: input bytes");
  const nameLength = Math.floor(WASM_FACTS_LIMITS.nameBytes / 2) + 1;
  const namePrefix = leb(nameLength);
  const header = new Uint8Array([0, ...leb(namePrefix.length + nameLength), ...namePrefix]);
  const manyNames = new Uint8Array(8 + 2 * (header.length + nameLength));
  manyNames.set([0, 97, 115, 109, 1, 0, 0, 0]);
  for (let i = 0, pos = 8; i < 2; i++, pos += header.length + nameLength) {
    manyNames.set(header, pos);
    manyNames.fill(0x61, pos + header.length, pos + header.length + nameLength);
  }
  expect(() => inspectWasmFacts(manyNames)).toThrow("inspection limit: name bytes");
});

test("default core declaration facts match native module reflection", async () => {
  const bytes = await Bun.file("target/wasm/liblvgl.wasm").arrayBuffer();
  const facts = inspectWasmFacts(bytes);
  const compiled = new WebAssembly.Module(bytes);
  expect(facts.imports.map(({ module, name, kind }) => ({ module, name, kind }))).toEqual(WebAssembly.Module.imports(compiled).map(({ module, name, kind }) => ({ module, name, kind })));
  expect(facts.exports.map(({ name, kind }) => ({ name, kind }))).toEqual(WebAssembly.Module.exports(compiled).map(({ name, kind }) => ({ name, kind })));
  expect(facts.sha256).toBe(createHash("sha256").update(new Uint8Array(bytes)).digest("hex"));
});

test("reader rejects malformed and unsupported declaration encodings", () => {
  const reject = (input: Uint8Array, message: string) => expect(() => inspectWasmFacts(input)).toThrow(message);
  reject(new Uint8Array([0, 97, 115]), "truncated");
  reject(wasm(section(1, [1, 0x5f])), "unsupported type definition");
  reject(wasm(section(1, [1, 0x60, 1, 0x63, 0])), "unsupported value type");
  reject(wasm(section(2, [1, 1, 0xff, 0, 0, 0])), "invalid UTF-8 name");
  reject(wasm(section(4, [1, 0x70, 1, 2, 1])), "table maximum is smaller");
  reject(wasm(section(5, [1, 2, 1])), "unsupported memory limits flags");
  reject(wasm(section(5, [1, 0x80, 0, 0])), "unsupported memory limits flags");
  reject(wasm(section(4, [1, 0x70, 0x80, 0, 0])), "unsupported table limits flags");
  reject(wasm(section(5, [1, 4, 0])), "unsupported memory limits flags");
  reject(wasm(section(5, [1, 0, ...leb(65537)])), "memory limits exceed wasm32");
  reject(wasm(section(5, [1, 0, 0x80, 0x80, 0x80, 0x80, 0x10])), "invalid u32 LEB");
  reject(wasm(section(5, [1, 0, 0x80])), "truncated");
  reject(wasm(section(6, [1, 0x7f, 0, 0x41, 0x80, 0x80, 0x80, 0x80, 0x08, 0x0b])), "invalid i32 LEB");
  reject(wasm(section(6, [1, 0x7f, 2, 0x41, 0, 0x0b])), "invalid global mutability");
  reject(wasm(section(6, [1, 0x7f, 0, 0x45, 0x0b])), "unsupported global initializer");
  reject(wasm(section(7, vec(exported("x", 0, 0)))), "function index 0 is out of bounds");
  reject(wasm(section(8, [0])), "start function index 0 is out of bounds");
  reject(wasm(section(5, [0]), section(4, [0])), "out-of-order");
  reject(wasm(section(5, [0]), section(5, [0])), "duplicate");
  reject(wasm(section(13, [1, 1, 0])), "unsupported tag attribute");
  reject(wasm(section(13, [1, 0, 0])), "tag type index 0 is out of bounds");
  reject(wasm(section(1, vec([0x60, 0, 1, 0x7f])), section(13, [1, 0, 0])), "tag type must not have results");
  reject(wasm(section(14, [0])), "unsupported section 14");
  reject(wasm(section(1, [0, 0])), "unexpected trailing bytes");
});
