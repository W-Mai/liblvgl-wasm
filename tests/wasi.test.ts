import { expect, test } from "bun:test";
import { createWasiImports, WASI_IMPORT_NAMES } from "../bindings/typescript/src/wasi.ts";

test("WASI realtime and monotonic clocks write nanoseconds to guest memory", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const wasi = createWasiImports(() => memory);
  const view = new DataView(memory.buffer);
  expect(WASI_IMPORT_NAMES).toContain("clock_time_get");
  const beforeWall = BigInt(Date.now()) * 1_000_000n;
  expect(wasi.clock_time_get(0, 1n, 3)).toBe(0);
  const afterWall = BigInt(Date.now()) * 1_000_000n;
  expect(view.getBigUint64(3, true)).toBeGreaterThanOrEqual(beforeWall);
  expect(view.getBigUint64(3, true)).toBeLessThanOrEqual(afterWall);
  const beforeMono = BigInt(Math.trunc(performance.now() * 1_000_000));
  expect(wasi.clock_time_get(1, 1n, 16)).toBe(0);
  const afterMono = BigInt(Math.trunc(performance.now() * 1_000_000));
  expect(view.getBigUint64(16, true)).toBeGreaterThanOrEqual(beforeMono);
  expect(view.getBigUint64(16, true)).toBeLessThanOrEqual(afterMono);
  const first = view.getBigUint64(16, true);
  expect(wasi.clock_time_get(1, 100n, 24)).toBe(0);
  expect(view.getBigUint64(24, true)).toBeGreaterThanOrEqual(first);
});

test("WASI clocks reject unsupported IDs and invalid guest pointers", () => {
  let memory: WebAssembly.Memory | undefined = new WebAssembly.Memory({ initial: 1 });
  const wasi = createWasiImports(() => memory);
  const view = new DataView(memory.buffer);
  view.setBigUint64(0, 0xdeadbeefn, true);
  expect(wasi.clock_time_get(2, 1n, 0)).toBe(58);
  expect(wasi.clock_time_get(3, 1n, 0)).toBe(58);
  expect(wasi.clock_time_get(4, 1n, 0)).toBe(28);
  expect(wasi.clock_time_get(-1, 1n, 0)).toBe(28);
  expect(view.getBigUint64(0, true)).toBe(0xdeadbeefn);
  expect(wasi.clock_time_get(0, 1n, 65528)).toBe(0);
  expect(wasi.clock_time_get(0, 1n, 65529)).toBe(21);
  expect(wasi.clock_time_get(1, 1n, -1)).toBe(21);
  expect(wasi.clock_time_get(1, 1n, -2147483648)).toBe(21);
  memory.grow(1);
  expect(wasi.clock_time_get(0, 1n, 65529)).toBe(0);
  memory = undefined;
  expect(wasi.clock_time_get(0, 1n, 0)).toBe(21);
});
