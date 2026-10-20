import { expect, test } from "bun:test";

interface TypeRef {
  id: string;
  qualifiers: string[];
}

interface Layout {
  status: "complete" | "opaque" | "incomplete" | "not_object";
  size: number | null;
  alignment: number | null;
}

interface TypeNode {
  kind: string;
  layout: Layout;
  origin_file?: string;
  underlying?: TypeRef;
  pointee?: TypeRef;
  element?: TypeRef;
  integer_type?: TypeRef;
  result?: TypeRef;
  parameters?: TypeRef[];
  fields?: { name: string | null; type: TypeRef; bit_offset: number; bit_width: number | null }[];
  record_kind?: string;
  length?: number | null;
  bound?: string;
  bits?: number;
}

test("target type metadata forms a closed graph for every public function", async () => {
  const report = await Bun.file("target/wasm/api.json").json() as {
    target: { pointer_bits: number };
    types: Record<string, TypeNode>;
    function_types: Record<string, { declared: TypeRef; canonical: TypeRef }>;
    type_summary: {
      total: number;
      kinds: Record<string, number>;
      records: Record<string, number>;
      bitfields: number;
    };
    declarations: { name: string; category: string }[];
  };
  const nodes = Object.values(report.types);
  expect(nodes.length).toBeGreaterThan(0);
  expect(report.type_summary.total).toBe(nodes.length);
  expect(Object.keys(report.types)).toEqual(Object.keys(report.types).sort());
  const counts = (values: string[]) => values.reduce<Record<string, number>>((result, key) => {
    result[key] = (result[key] ?? 0) + 1;
    return result;
  }, {});
  expect(report.type_summary.kinds).toEqual(counts(nodes.map((node) => node.kind)));
  expect(report.type_summary.records).toEqual(
    counts(nodes.filter((node) => node.kind === "record").map((node) => node.layout.status)),
  );
  expect(report.type_summary.bitfields).toBe(
    nodes.flatMap((node) => node.fields ?? []).filter((field) => field.bit_width !== null).length,
  );
  function reference(ref: TypeRef): TypeNode {
    expect(ref.qualifiers).toEqual([...new Set(ref.qualifiers)].sort());
    for (const qualifier of ref.qualifiers) expect(["const", "restrict", "volatile"]).toContain(qualifier);
    expect(Object.hasOwn(report.types, ref.id)).toBe(true);
    return report.types[ref.id]!;
  }
  for (const node of nodes) {
    expect(["primitive", "void", "alias", "pointer", "array", "record", "enum", "function"]).toContain(node.kind);
    if (node.origin_file) expect(node.origin_file).toMatch(/^(lvgl|config|sdk|resource)\/|^<built-in>$/);
    const { status, size, alignment } = node.layout;
    expect(["complete", "opaque", "incomplete", "not_object"]).toContain(status);
    if (status === "complete") {
      expect(Number.isInteger(size) && size! >= 0).toBe(true);
      expect(Number.isInteger(alignment) && alignment! > 0).toBe(true);
      expect(alignment! & (alignment! - 1)).toBe(0);
      if (node.kind !== "alias") expect(size! % alignment!).toBe(0);
    } else {
      expect(size).toBeNull();
      expect(alignment).toBeNull();
    }
    if (node.kind === "primitive") expect(node.bits).toBe(size! * 8);
    if (node.kind === "alias") {
      expect(status).toBe(reference(node.underlying!).layout.status);
    }
    if (node.kind === "enum") expect(node.layout).toEqual(reference(node.integer_type!).layout);
    if (node.kind === "pointer") {
      reference(node.pointee!);
      expect(size! * 8).toBe(report.target.pointer_bits);
    }
    if (node.kind === "array") {
      const element = reference(node.element!);
      if (node.bound === "constant") {
        expect(Number.isInteger(node.length) && node.length! >= 0).toBe(true);
        expect(size).toBe(node.length! * element.layout.size!);
      } else {
        expect(["incomplete", "variable"]).toContain(node.bound!);
        expect(node.length).toBeNull();
        expect(status).toBe("incomplete");
      }
    }
    if (node.kind === "void" || node.kind === "function") expect(status).toBe("not_object");
    if (node.kind === "function") {
      reference(node.result!);
      for (const parameter of node.parameters!) reference(parameter);
    }
    if (node.kind === "record") {
      expect(["struct", "union"]).toContain(node.record_kind!);
      expect(["complete", "opaque"]).toContain(status);
      expect(Array.isArray(node.fields)).toBe(status === "complete");
      for (const field of node.fields ?? []) {
        const type = reference(field.type);
        expect(Number.isInteger(field.bit_offset) && field.bit_offset >= 0).toBe(true);
        if (node.record_kind === "union") expect(field.bit_offset).toBe(0);
        if (field.bit_width !== null) {
          expect(Number.isInteger(field.bit_width) && field.bit_width >= 0).toBe(true);
          expect(field.bit_width).toBeLessThanOrEqual(type.layout.size! * 8);
        }
        const bits = field.bit_width ?? (type.layout.size ?? 0) * 8;
        expect(field.bit_offset + bits).toBeLessThanOrEqual(size! * 8);
      }
    }
  }
  expect(Object.keys(report.function_types)).toEqual(report.declarations.map((entry) => entry.name).sort());
  for (const entry of Object.values(report.function_types)) {
    const declared = reference(entry.declared);
    const canonical = reference(entry.canonical);
    expect(declared.kind).toBe("function");
    expect(canonical.kind).toBe("function");
    expect(canonical.parameters!.length).toBe(declared.parameters!.length);
    for (const parameter of canonical.parameters!) {
      expect(parameter.qualifiers).toEqual([]);
      expect(["alias", "array", "function", "void"]).not.toContain(reference(parameter).kind);
    }
  }
  for (const entry of report.declarations.filter((entry) => entry.category === "direct_export")) {
    const canonical = reference(report.function_types[entry.name]!.canonical);
    for (const value of [canonical.result!, ...canonical.parameters!]) {
      expect(reference(value).kind).not.toBe("record");
    }
  }
});
