import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

interface Signature {
  params: ("i32" | "i64" | "f32" | "f64")[];
  results: ("i32" | "i64" | "f32" | "f64")[];
}

function u32(value: number): number[] {
  const bytes = [];
  do {
    const byte = value & 0x7f;
    value >>>= 7;
    bytes.push(byte | (value ? 0x80 : 0));
  } while (value);
  return bytes;
}

function vector(items: number[][]): number[] {
  return [...u32(items.length), ...items.flat()];
}

function name(value: string): number[] {
  const bytes = new TextEncoder().encode(value);
  return [...u32(bytes.length), ...bytes];
}

function section(id: number, bytes: number[]): number[] {
  return [id, ...u32(bytes.length), ...bytes];
}

test("every supported API links with its recorded Wasm signature", async () => {
  const apiBytes = await Bun.file("target/wasm/api.json").bytes();
  const wasmBytes = await Bun.file("target/wasm/liblvgl.wasm").bytes();
  const report = JSON.parse(new TextDecoder().decode(apiBytes)) as {
    wasm_summary: { expected_functions: number };
    declarations: {
      category: string;
      export_name: string | null;
      wasm_signature: Signature | null;
    }[];
  };
  const verification = await Bun.file("target/wasm/api-verification.json").json();
  expect(verification.schema_version).toBe(1);
  expect(verification.api_sha256).toBe(createHash("sha256").update(apiBytes).digest("hex"));
  expect(verification.wasm_sha256).toBe(createHash("sha256").update(wasmBytes).digest("hex"));

  const types: number[][] = [];
  const typeIndices = new Map<string, number>();
  const imports: number[][] = [];
  const scalar = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };
  for (const entry of report.declarations) {
    if (entry.category !== "direct_export" && entry.category !== "abi_shim") {
      expect(entry.wasm_signature).toBeNull();
      continue;
    }
    expect(entry.export_name).toBeString();
    expect(entry.wasm_signature).not.toBeNull();
    const signature = entry.wasm_signature!;
    const key = JSON.stringify(signature);
    if (!typeIndices.has(key)) {
      typeIndices.set(key, types.length);
      const values = (items: Signature["params"]) => items.map((value) => {
        expect(Object.hasOwn(scalar, value)).toBe(true);
        return [scalar[value]];
      });
      types.push([0x60, ...vector(values(signature.params)), ...vector(values(signature.results))]);
    }
    imports.push([...name("api"), ...name(entry.export_name!), 0, ...u32(typeIndices.get(key)!)]);
  }
  expect(imports.length).toBeGreaterThan(0);
  expect(report.wasm_summary.expected_functions).toBe(imports.length);
  expect(verification.expected_functions).toBe(imports.length);
  expect(verification.verified_functions).toBe(imports.length);

  // The engine checks each import type independently of the metadata reader.
  const consumer = Uint8Array.from([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, vector(types)), ...section(2, vector(imports)),
  ]);
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    lvw: { event() {} },
    wasi_snapshot_preview1: { fd_close() { return 0; }, fd_write() { return 0; } },
  });
  await WebAssembly.instantiate(consumer, { api: instance.exports });
});
