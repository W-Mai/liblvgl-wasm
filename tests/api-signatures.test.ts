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
    lvw: { event() {}, timer() {}, timer_release() {} },
    wasi_snapshot_preview1: { fd_close() { return 0; }, fd_write() { return 0; } },
  });
  await WebAssembly.instantiate(consumer, { api: instance.exports });
});

test("callback typedef signatures link against target compiler probes", async () => {
  interface Ref { id: string; qualifiers: string[] }
  interface TypeNode {
    kind: string;
    name?: string;
    underlying?: Ref;
    pointee?: Ref;
  }
  const report = await Bun.file("target/wasm/api.json").json() as {
    types: Record<string, TypeNode>;
    callback_types: Record<string, { function_type: Ref; wasm_signature: Signature }>;
    callback_summary: { typedefs: number; function_types: number; wasm_signatures: number };
  };
  function unalias(ref: Ref): Ref {
    const seen = new Set<string>();
    while (report.types[ref.id]!.kind === "alias") {
      expect(seen.has(ref.id)).toBe(false);
      seen.add(ref.id);
      ref = report.types[ref.id]!.underlying!;
    }
    return ref;
  }
  const expected = Object.entries(report.types).flatMap(([id, node]) => {
    if (node.kind !== "alias") return [];
    const pointer = report.types[unalias(node.underlying!).id]!;
    return pointer.kind === "pointer"
      && report.types[unalias(pointer.pointee!).id]!.kind === "function" ? [id] : [];
  });
  expect(Object.keys(report.callback_types)).toEqual(expected.sort());
  expect(expected.length).toBeGreaterThan(0);

  const definitions: number[][] = [];
  const functions: number[][] = [];
  const exports: number[][] = [];
  const bodies: number[][] = [];
  const byFunction = new Map<string, Signature>();
  const scalar = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };
  const zero = { i32: [0x41, 0], i64: [0x42, 0], f32: [0x43, 0, 0, 0, 0], f64: [0x44, 0, 0, 0, 0, 0, 0, 0, 0] };
  for (const [id, entry] of Object.entries(report.callback_types)) {
    const alias = report.types[id]!;
    const pointer = report.types[unalias(alias.underlying!).id]!;
    expect(entry.function_type).toEqual(unalias(pointer.pointee!));
    expect(report.types[entry.function_type.id]!.kind).toBe("function");
    expect(alias.name).toMatch(/^[A-Za-z_]\w*$/);
    const signature = entry.wasm_signature;
    expect(Object.keys(signature).sort()).toEqual(["params", "results"]);
    expect(signature.results.length).toBeLessThanOrEqual(1);
    if (byFunction.has(entry.function_type.id)) {
      expect(signature).toEqual(byFunction.get(entry.function_type.id)!);
    }
    byFunction.set(entry.function_type.id, signature);
    const values = (items: Signature["params"]) => items.map((value) => {
      expect(Object.hasOwn(scalar, value)).toBe(true);
      return [scalar[value]];
    });
    const index = definitions.length;
    definitions.push([0x60, ...vector(values(signature.params)), ...vector(values(signature.results))]);
    functions.push(u32(index));
    exports.push([...name(`lvw_callback_probe_${alias.name}`), 0, ...u32(index)]);
    const body = [0, ...signature.results.flatMap((type) => zero[type]), 0x0b];
    bodies.push([...u32(body.length), ...body]);
  }
  expect(report.callback_summary).toEqual({
    typedefs: expected.length,
    function_types: byFunction.size,
    wasm_signatures: new Set(Object.values(report.callback_types).map((entry) => JSON.stringify(entry.wasm_signature))).size,
  });
  const producer = Uint8Array.from([
    0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, vector(definitions)), ...section(3, vector(functions)),
    ...section(7, vector(exports)), ...section(10, vector(bodies)),
  ]);
  const { instance } = await WebAssembly.instantiate(producer);
  const probe = await WebAssembly.compile(await Bun.file("target/wasm/callback-signatures.o").bytes());
  const imports = WebAssembly.Module.imports(probe);
  expect(imports.filter((entry) => entry.kind === "function").map((entry) => entry.name).sort()).toEqual(
    Object.keys(instance.exports).sort(),
  );
  const env: Record<string, WebAssembly.ImportValue> = { ...instance.exports };
  for (const entry of imports) {
    expect(entry.module).toBe("env");
    if (entry.kind === "function") continue;
    if (entry.kind === "memory" && entry.name === "__linear_memory") {
      env[entry.name] = new WebAssembly.Memory({ initial: Math.max(1, Math.ceil(expected.length * 4 / 65536)) });
    } else if (entry.kind === "table" && entry.name === "__indirect_function_table") {
      env[entry.name] = new WebAssembly.Table({ element: "anyfunc", initial: expected.length + 1 });
    } else {
      throw new Error(`unexpected callback probe import: ${entry.module}.${entry.name} (${entry.kind})`);
    }
  }
  // Linking checks compiler lowering without reusing the generator's Wasm reader.
  await WebAssembly.instantiate(probe, { env });
});
