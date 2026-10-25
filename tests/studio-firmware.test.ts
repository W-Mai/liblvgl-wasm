import { expect, test } from "bun:test";
import { FIRMWARE_REQUIRED_EXPORTS } from "../studio/src/artifacts.ts";
import { copyFirmwareFrame, FirmwareRuntime } from "../studio/src/firmware.ts";

function u32(value: number): number[] {
  const bytes: number[] = [];
  do {
    const next = value >>> 7;
    bytes.push((value & 0x7f) | (next ? 0x80 : 0));
    value = next;
  } while (value);
  return bytes;
}

function text(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [...u32(bytes.length), ...bytes];
}

function section(id: number, payload: number[]): number[] {
  return [id, ...u32(payload.length), ...payload];
}

function firmwareModule(): Uint8Array {
  const functions = FIRMWARE_REQUIRED_EXPORTS.filter((name) => name !== "memory");
  const type = [0x01, 0x60, 0x00, 0x01, 0x7f];
  const functionSection = [...u32(functions.length), ...functions.map(() => 0x00)];
  const memorySection = [0x01, 0x00, 0x01];
  const exportSection = [
    ...u32(functions.length + 1),
    ...text("memory"), 0x02, 0x00,
    ...functions.flatMap((name, index) => [...text(name), 0x00, ...u32(index)]),
  ];
  const codeSection = [
    ...u32(functions.length),
    ...functions.flatMap((name) => [0x04, 0x00, 0x41, name === "lvw_firmware_abi_version" ? 1 : 0, 0x0b]),
  ];
  return new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, type), ...section(3, functionSection), ...section(5, memorySection),
    ...section(7, exportSection), ...section(10, codeSection),
  ]);
}

test("firmware runtime validates ABI 1 and exposes a stable report", async () => {
  const runtime = await FirmwareRuntime.load(firmwareModule(), 2, 2);
  expect(runtime.report.abi).toBe(1);
  expect(runtime.report.sha256).toHaveLength(64);
  expect(runtime.step(16)).toBe(false);
});

test("firmware frame copies are bounded and use packed RGBA8888", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  new Uint8Array(memory.buffer, 8, 16).fill(0x7a);
  expect([...new Uint8Array(copyFirmwareFrame(memory, 8, 16, 2, 2))]).toEqual(new Array(16).fill(0x7a));
  expect(() => copyFirmwareFrame(memory, 8, 15, 2, 2)).toThrow("must be 16 bytes");
  expect(() => copyFirmwareFrame(memory, 65_528, 16, 2, 2)).toThrow("within exported memory");
});

