import { expect, test } from "bun:test";
import { inspectWasmFacts } from "../bindings/typescript/src/wasm-facts.ts";

test("fixed-table core retains its verified baseline interface and cannot grow the table", async () => {
  const api = await Bun.file("target/wasm/api.json").bytes();
  const original = await Bun.file("target/wasm/liblvgl.wasm").bytes();
  const bounded = await Bun.file("target/wasm/liblvgl-bounded.wasm").bytes();
  const proof = await Bun.file("target/wasm/api-verification-bounded.json").json();
  const oldFacts = inspectWasmFacts(original);
  const facts = inspectWasmFacts(bounded);
  expect(proof.api_sha256).toBe(new Bun.CryptoHasher("sha256").update(api).digest("hex"));
  expect(proof.wasm_sha256).toBe(facts.sha256);
  expect(proof.verified_functions).toBe(proof.expected_functions);
  expect(facts.sha256).not.toBe(oldFacts.sha256);
  expect(facts.imports).toEqual(oldFacts.imports);
  expect(facts.memories).toEqual(oldFacts.memories);
  expect(facts.tables).toHaveLength(1);
  expect(oldFacts.tables[0]!.type.maximum).toBeNull();
  expect(facts.tables[0]!.type.minimum).toBe(oldFacts.tables[0]!.type.minimum);
  expect(facts.tables[0]!.type.maximum).toBe(facts.tables[0]!.type.minimum);
  const module = new WebAssembly.Module(bounded);
  const imports: Record<string, Record<string, () => number>> = Object.create(null);
  for (const entry of WebAssembly.Module.imports(module)) {
    expect(entry.kind).toBe("function");
    (imports[entry.module] ??= Object.create(null))[entry.name] = () => 0;
  }
  const instance = new WebAssembly.Instance(module, imports);
  const table = instance.exports.__indirect_function_table;
  expect(table).toBeInstanceOf(WebAssembly.Table);
  expect(() => (table as WebAssembly.Table).grow(1)).toThrow(RangeError);
  expect((table as WebAssembly.Table).length).toBe(facts.tables[0]!.type.minimum);
});
