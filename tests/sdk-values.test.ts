import { expect, test } from "bun:test";
import * as sdk from "../bindings/typescript/src/index.ts";
import * as values from "../target/typescript/values.ts";

interface Layout {
  status: string;
  size: number | null;
  alignment: number | null;
}

interface TypeNode {
  kind: string;
  name?: string;
  origin_file?: string;
  record_kind?: string;
  underlying?: { id: string };
  layout: Layout;
  fields?: { name: string | null; type: { id: string }; bit_offset: number; bit_width: number | null }[];
}

test("SDK values exactly represent supported constants and named target layouts", async () => {
  const report = await Bun.file("target/wasm/api.json").json() as {
    constants: { name: string; category: string; bits?: number; value?: string; bytes_hex?: string }[];
    types: Record<string, TypeNode>;
  };
  const expected: Record<string, unknown> = { valuesIdentity: sdk.bindingIdentity };
  for (const entry of report.constants) {
    if (entry.category === "integer") {
      expected[entry.name] = entry.bits! <= 32 ? Number(entry.value) : BigInt(entry.value!);
    } else if (entry.category === "string") {
      expected[entry.name] = [...Buffer.from(entry.bytes_hex!, "hex")];
    }
  }
  for (const node of Object.values(report.types)) {
    if (!["alias", "record"].includes(node.kind) || !node.name || !node.origin_file?.startsWith("lvgl/")) continue;
    const prefix = (node.kind === "record" ? `${node.record_kind}_` : "") + node.name;
    const name = prefix.toUpperCase();
    expected[`${name}_STATUS`] = node.layout.status;
    if (node.layout.status !== "complete") continue;
    expected[`${name}_SIZE`] = node.layout.size;
    expected[`${name}_ALIGN`] = node.layout.alignment;
    let record = node;
    const visited = new Set<TypeNode>();
    while (record.kind === "alias") {
      expect(visited.has(record)).toBe(false);
      visited.add(record);
      record = report.types[record.underlying!.id]!;
    }
    if (record.kind === "record") {
      expected[`${name}_FIELDS`] = record.fields!.map((field) => ({
        name: field.name, type_id: field.type.id, bit_offset: field.bit_offset, bit_width: field.bit_width,
      }));
    }
  }
  expect(Object.keys(values).sort()).toEqual(Object.keys(expected).sort());
  for (const [name, value] of Object.entries(expected)) {
    const generated = (values as Record<string, unknown>)[name];
    expect(generated).toEqual(value);
    expect((sdk as Record<string, unknown>)[name]).toBe(generated);
    if (Array.isArray(generated)) {
      expect(Object.isFrozen(generated)).toBe(true);
      for (const field of generated) {
        if (typeof field === "object") expect(Object.isFrozen(field)).toBe(true);
      }
    }
  }
  expect(values.valuesIdentity).toEqual(sdk.bindingIdentity);
  expect(Object.isFrozen(values.valuesIdentity)).toBe(true);
});
