import { expect, test } from "bun:test";
import { LvglRuntime } from "../bindings/typescript/src/index.ts";

interface Constant {
  name: string;
  origin: "macro" | "enum";
  origin_file: string;
  line: number;
  category: "integer" | "string" | "function_macro" | "empty_macro" | "unsupported";
  c_type?: string;
  bits?: number;
  signed?: boolean;
  value?: string;
  bytes_hex?: string;
  byte_length?: number;
  nul_terminated?: boolean;
  text?: string;
  parameters?: string[];
  expression?: string;
  reason_code?: string;
  reason?: string;
}

async function report() {
  return await Bun.file("target/wasm/api.json").json() as {
    schema_version: number;
    target: { triple: string; pointer_bits: number; endianness: string; data_layout: string };
    constant_summary: Record<Constant["category"] | "total", number>;
    constants: Constant[];
  };
}

test("constant metadata preserves target values and classifies every candidate", async () => {
  const inventory = await report();
  expect(inventory.schema_version).toBe(1);
  expect(inventory.target.triple).toMatch(/^wasm32-/);
  expect(inventory.target.pointer_bits).toBe(32);
  expect(inventory.target.endianness).toBe("little");
  expect(inventory.target.data_layout).toMatch(/^e-/);

  const names = inventory.constants.map((entry) => entry.name);
  expect(names.length).toBeGreaterThan(0);
  expect(names).toEqual([...new Set(names)].sort());
  expect(inventory.constant_summary.total).toBe(names.length);
  const categories = ["integer", "string", "function_macro", "empty_macro", "unsupported"] as const;
  for (const category of categories) {
    expect(inventory.constant_summary[category]).toBe(
      inventory.constants.filter((entry) => entry.category === category).length,
    );
  }
  expect(categories.reduce((total, category) => total + inventory.constant_summary[category], 0)).toBe(names.length);

  for (const entry of inventory.constants) {
    expect(entry.name).toMatch(/^(LV_|LVGL_)/);
    expect(["macro", "enum"]).toContain(entry.origin);
    expect(entry.origin_file).not.toMatch(/^(\/|[A-Za-z]:)/);
    expect(entry.origin_file.length).toBeGreaterThan(0);
    expect(entry.line).toBeGreaterThanOrEqual(0);
    if (entry.category === "integer") {
      expect(entry.c_type?.length).toBeGreaterThan(0);
      expect(Number.isInteger(entry.bits)).toBe(true);
      expect(entry.bits!).toBeGreaterThan(0);
      expect(typeof entry.signed).toBe("boolean");
      expect(typeof entry.value).toBe("string");
      const value = BigInt(entry.value!);
      expect(value.toString()).toBe(entry.value!);
      const magnitude = 1n << BigInt(entry.bits! - (entry.signed ? 1 : 0));
      expect(value >= (entry.signed ? -magnitude : 0n)).toBe(true);
      expect(value < magnitude).toBe(true);
    } else if (entry.category === "string") {
      expect(entry.c_type?.length).toBeGreaterThan(0);
      expect(entry.bytes_hex).toMatch(/^(?:[0-9a-f]{2})*$/);
      const bytes = Buffer.from(entry.bytes_hex!, "hex");
      expect(bytes.length).toBe(entry.byte_length!);
      expect(entry.nul_terminated).toBe(bytes.at(-1) === 0);
      let decoded: string | undefined;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          entry.nul_terminated ? bytes.subarray(0, -1) : bytes,
        );
      } catch {
        decoded = undefined;
      }
      expect(entry.text).toBe(decoded);
    } else if (entry.category === "function_macro") {
      expect(entry.origin).toBe("macro");
      expect(Array.isArray(entry.parameters)).toBe(true);
      expect(typeof entry.expression).toBe("string");
    } else if (entry.category === "empty_macro") {
      expect(entry.expression).toBe("");
    } else {
      expect(entry.reason_code?.length).toBeGreaterThan(0);
      expect(entry.reason?.length).toBeGreaterThan(0);
    }
  }
});

test("generated event constant agrees with the running core", async () => {
  const inventory = await report();
  const clicked = inventory.constants.find((entry) => entry.name === "LV_EVENT_CLICKED");
  expect(clicked?.category).toBe("integer");
  const runtime = await LvglRuntime.load(await Bun.file("target/wasm/liblvgl.wasm").arrayBuffer());
  try {
    expect(BigInt(clicked!.value!)).toBe(BigInt(runtime.clickedEvent));
  } finally {
    runtime.shutdown();
  }
});
