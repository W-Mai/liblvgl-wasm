import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectWasmFacts } from "../bindings/typescript/src/wasm-facts.ts";

const empty = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
const cases: readonly [string, number, number][] = [
  ["bulk-memory", 0, 0], ["reference-types", 1, 0], ["sign-extension", 2, 0],
  ["saturating-float-to-int", 3, 0], ["exceptions", 4, 0], ["simd", 5, 0],
  ["multi-value", 6, 0], ["threads", 7, 0], ["memory64", 8, 0],
  ["multi-memory", 9, 0], ["tail-call", 10, 0], ["extended-const", 11, 0],
  ["relaxed-simd", 12, 1 << 5], ["legacy-exceptions", 13, 0],
  ["function-references", 14, 1 << 1], ["gc", 15, (1 << 1) | (1 << 14)],
];

type HelperExports = WebAssembly.Exports & {
  memory: WebAssembly.Memory;
  lvw_reserve(length: number): number;
  lvw_validate(mask: number): number;
  lvw_release(): number;
};

test("feature helper validates instructions under its explicit feature mask", async () => {
  const bytes = await Bun.file("target/validator/feature-validator.wasm").bytes();
  const module = new WebAssembly.Module(bytes);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  expect(inspectWasmFacts(bytes).memories).toEqual([{ index: 0, imported: false, type: { minimumPages: 32, maximumPages: 4096, shared: false } }]);
  const helper = new WebAssembly.Instance(module).exports as HelperExports;
  expect(helper.memory.buffer.byteLength).toBe(2 * 1024 * 1024);
  expect(() => helper.memory.grow(4096)).toThrow();

  const check = (input: Uint8Array, mask: number) => {
    const pointer = helper.lvw_reserve(input.length) >>> 0;
    expect(pointer).toBeGreaterThan(0);
    expect(pointer + input.length).toBeLessThanOrEqual(helper.memory.buffer.byteLength);
    new Uint8Array(helper.memory.buffer, pointer, input.length).set(input);
    const result = helper.lvw_validate(mask);
    expect(helper.lvw_release()).toBe(1);
    return result;
  };
  expect(check(empty, 0)).toBe(0);
  for (const [name, bit, dependencies] of cases) {
    const input = await Bun.file(`target/validator/fixtures/${name}.wasm`).bytes();
    expect(check(input, dependencies)).toBe(1);
    expect(check(input, dependencies | (1 << bit))).toBe(0);
  }
  const simd = await Bun.file("target/validator/fixtures/simd.wasm").bytes();
  const spoofed = new Uint8Array([...simd, 0, 17, 15, ...new TextEncoder().encode("target_features"), 0]);
  expect(check(spoofed, 0)).toBe(1);
  const custom = new Uint8Array([...empty, 0, 4, 0, 253, 12, 255]);
  expect(check(custom, 0)).toBe(0);
  expect(check(new Uint8Array([0, 97, 115, 109]), 0)).toBe(1);
  expect(check(empty, 0x80000000)).toBe(-1);
});

test("failed helper builds remove stale output", async () => {
  const root = mkdtempSync(join(tmpdir(), "lvw-validator-build-"));
  try {
    const validator = join(root, "validator"), output = join(root, "target/validator/feature-validator.wasm");
    mkdirSync(validator, { recursive: true });
    mkdirSync(join(root, "target/validator"), { recursive: true });
    copyFileSync("validator/build.sh", join(validator, "build.sh"));
    copyFileSync("validator/build-helper.py", join(validator, "build-helper.py"));
    writeFileSync(output, "stale");
    const compiler = join(root, "failing-rustc");
    writeFileSync(compiler, "#!/bin/sh\nexit 1\n");
    chmodSync(compiler, 0o755);
    const child = Bun.spawn(["sh", join(validator, "build.sh")], { env: { ...process.env, RUSTC: compiler }, stdout: "ignore", stderr: "ignore" });
    expect(await child.exited).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("feature helper owns one bounded input and invalidates failed reservations", async () => {
  const bytes = await Bun.file("target/validator/feature-validator.wasm").bytes();
  const helper = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports as HelperExports;
  expect(helper.lvw_validate(0)).toBe(-2);
  expect(helper.lvw_release()).toBe(0);
  expect(helper.lvw_reserve(0)).toBe(0);
  expect(helper.lvw_reserve(64 * 1024 * 1024 + 1)).toBe(0);
  expect(helper.lvw_reserve(-1)).toBe(0);
  expect(helper.lvw_reserve(empty.length)).toBeGreaterThan(0);
  expect(helper.lvw_reserve(empty.length)).toBe(0);
  expect(helper.lvw_validate(0)).toBe(-2);
  expect(helper.lvw_release()).toBe(0);
  const pointer = helper.lvw_reserve(empty.length) >>> 0;
  expect(pointer).toBeGreaterThan(0);
  new Uint8Array(helper.memory.buffer, pointer, empty.length).set(empty);
  expect(helper.lvw_validate(0)).toBe(0);
  expect(helper.lvw_release()).toBe(1);
  expect(helper.lvw_validate(0)).toBe(-2);
});
