import { expect, test } from "bun:test";
import {
  APP_REQUIRED_EXPORTS, CORE_REQUIRED_EXPORTS, FIRMWARE_REQUIRED_EXPORTS,
  inspectArtifact,
} from "../studio/src/artifacts.ts";
import { resolveCompatibilityAdapter } from "../studio/src/compatibility.ts";

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

function moduleBytes(exports: string[], imports: string[] = [], memoryKind: "memory" | "function" = "memory"): Uint8Array {
  const functions = exports.filter((name) => name !== "memory" || memoryKind === "function");
  const types = [0x01, 0x60, 0x00, 0x01, 0x7f];
  const importPayload = [
    ...u32(imports.length),
    ...imports.flatMap((name) => {
      const [module, item] = name.split(".", 2);
      return [...text(module), ...text(item), 0x00, 0x00];
    }),
  ];
  const functionPayload = [...u32(functions.length), ...functions.flatMap(() => [0x00])];
  const memoryPayload = [0x01, 0x00, 0x01];
  const exportPayload = [
    ...u32(exports.length),
    ...exports.flatMap((name) => name === "memory" && memoryKind === "memory"
      ? [...text(name), 0x02, 0x00]
      : [...text(name), 0x00, ...u32(imports.length + functions.indexOf(name))]),
  ];
  const codePayload = [
    ...u32(functions.length),
    ...functions.flatMap(() => [0x04, 0x00, 0x41, 0x00, 0x0b]),
  ];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, types),
    ...(imports.length ? section(2, importPayload) : []),
    ...section(3, functionPayload),
    ...section(5, memoryPayload),
    ...section(7, exportPayload),
    ...section(10, codePayload),
  ]);
}

test("inspects a bridge core without claiming an LVGL version", async () => {
  const bytes = moduleBytes([...CORE_REQUIRED_EXPORTS], ["lvw.event", "wasi_snapshot_preview1.fd_write"]);
  const report = await inspectArtifact(bytes, "core");
  expect(report.kind).toBe("lvgl-core");
  expect(report.mode).toBe("lvgl-app");
  expect(report.identity?.sdk).toBe("unknown");
  expect(report.capabilities.find((item) => item.id === "lvw.bridge")?.state).toBe("available");
  expect(report.capabilities.find((item) => item.id === "lvgl.identity")?.state).toBe("unknown");
});

test("classifies the existing application ABI independently from a core", async () => {
  const bytes = moduleBytes([...APP_REQUIRED_EXPORTS], ["lvw_app.screen", "lvw_app.log"]);
  const report = await inspectArtifact(bytes, "application");
  expect(report.kind).toBe("lvw-app");
  expect(report.mode).toBe("lvgl-app");
  expect(report.capabilities.find((item) => item.id === "lvw-app.abi")?.state).toBe("available");
  expect((await inspectArtifact(bytes, "core")).mode).toBe("unavailable");
});

test("classifies standalone firmware and rejects imports outside WASI", async () => {
  const bytes = moduleBytes([...FIRMWARE_REQUIRED_EXPORTS], ["wasi_snapshot_preview1.fd_write"]);
  const report = await inspectArtifact(bytes, "application");
  expect(report.kind).toBe("firmware");
  expect(report.mode).toBe("firmware");
  expect(report.capabilities.find((item) => item.id === "lvw-firmware.abi")?.state).toBe("available");

  const foreign = await inspectArtifact(moduleBytes([...FIRMWARE_REQUIRED_EXPORTS], ["env.host_call"]), "application");
  expect(foreign.kind).toBe("unknown");
  expect(foreign.mode).toBe("unavailable");
  expect(foreign.reasons.some((reason) => reason.includes("unsupported imports"))).toBe(true);
});

test("reports malformed and unknown modules without instantiation", async () => {
  const malformed = await inspectArtifact(new Uint8Array([1, 2, 3]));
  expect(malformed.kind).toBe("unknown");
  expect(malformed.mode).toBe("unavailable");
  expect(malformed.capabilities[0]?.state).toBe("blocked");

  const unknown = await inspectArtifact(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  expect(unknown.kind).toBe("unknown");
  expect(unknown.reasons.length).toBeGreaterThan(0);
  expect(unknown.sha256).toHaveLength(64);
});

test("requires the memory export to have the memory kind", async () => {
  const bytes = moduleBytes([...CORE_REQUIRED_EXPORTS], ["lvw.event", "wasi_snapshot_preview1.fd_write"], "function");
  const report = await inspectArtifact(bytes, "core");
  expect(report.kind).toBe("unknown");
  expect(report.capabilities.find((item) => item.id === "wasm.memory")?.state).toBe("missing");
  expect(report.reasons.some((reason) => reason.includes("memory (function; expected memory)"))).toBe(true);
});

test("compatibility adapters require an exact caller-supplied registry entry", () => {
  const entry = {
    id: "lvgl-9.1-observer",
    sourceSha256: "source-91",
    coreSha256: "core-91",
    capabilities: ["observer"],
  } as const;
  expect(resolveCompatibilityAdapter({ sourceSha256: entry.sourceSha256, coreSha256: entry.coreSha256 }, [])).toBeUndefined();
  expect(resolveCompatibilityAdapter({ sourceSha256: entry.sourceSha256, coreSha256: entry.coreSha256 }, [entry])).toEqual(entry);
  expect(resolveCompatibilityAdapter({ sourceSha256: "source-90", coreSha256: entry.coreSha256 }, [entry])).toBeUndefined();
  expect(resolveCompatibilityAdapter({ sourceSha256: entry.sourceSha256, coreSha256: "core-90" }, [entry])).toBeUndefined();
});

