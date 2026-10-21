import { expect, test } from "bun:test";
import { describeCore, inspectCore } from "../studio/src/core.ts";
import { LvglRuntime } from "../bindings/typescript/src/index.ts";

test("studio accepts the built core and rejects missing bridge exports", async () => {
  const bytes = await Bun.file("target/wasm/liblvgl.wasm").arrayBuffer();
  const info = await inspectCore(bytes);
  expect(info.exports).toContain("lvw_step");
  expect(info.imports).toContain("lvw.event");

  const emptyModule = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  expect(inspectCore(emptyModule)).rejects.toThrow("missing required exports");
});

test("studio reports generated configuration only for the loaded core's matching SDK", async () => {
  const bytes = await Bun.file("target/wasm/liblvgl.wasm").bytes();
  const info = await inspectCore(bytes);
  const metadata = await Bun.file("target/wasm/api.json").json();
  const constants = new Map<string, string>(metadata.constants
    .filter((item: { category: string }) => item.category === "integer")
    .map((item: { name: string; value: string }) => [item.name, item.value]));
  const runtime = await LvglRuntime.load(bytes);
  try {
    const report = describeCore(runtime.identity, info);
    expect(report.identity).toBe(runtime.identity);
    expect(report.imports).toBe(info.imports.length);
    expect(report.exports).toBe(info.exports.length);
    expect(report.build?.version).toBe(["MAJOR", "MINOR", "PATCH"]
      .map((part) => constants.get(`LVGL_VERSION_${part}`)).join("."));
    const macros = new Map([
      ["PNG", "LV_USE_LODEPNG"], ["BMP", "LV_USE_BMP"], ["GIF", "LV_USE_GIF"],
      ["TinyTTF", "LV_USE_TINY_TTF"], ["FreeType", "LV_USE_FREETYPE"],
      ["Vector graphics", "LV_USE_VECTOR_GRAPHIC"], ["SVG geometry", "LV_USE_SVG"],
      ["Lottie", "LV_USE_LOTTIE"],
    ]);
    expect(report.build?.features.length).toBe(macros.size);
    for (const feature of report.build!.features) {
      const value = constants.get(macros.get(feature.name)!);
      expect(value).toBeDefined();
      expect(feature.enabled).toBe(BigInt(value!) !== 0n);
    }
    const identity = runtime.identity;
    for (const status of ["core-mismatch", "values-mismatch"] as const) {
      expect(describeCore({ ...identity, sdk: { ...identity.sdk, status } }, info).build).toBeNull();
    }
    expect(describeCore({ ...identity, coreSha256: "0".repeat(64) }, info).build).toBeNull();
    expect(describeCore({ ...identity, sdk: { ...identity.sdk, apiSha256: "0".repeat(64) } }, info).build).toBeNull();
  } finally {
    runtime.shutdown();
  }

  // A valid custom section changes byte identity without changing the bridge.
  const custom = new Uint8Array(bytes.length + 3);
  custom.set(bytes);
  custom.set([0, 1, 0], bytes.length);
  const foreign = await LvglRuntime.load(custom);
  try {
    const report = describeCore(foreign.identity, await inspectCore(custom));
    expect(report.identity.sdk.status).toBe("core-mismatch");
    expect(report.build).toBeNull();
    expect(foreign.createDisplay(32, 24).handle).toBeGreaterThan(0);
    expect(() => foreign.unsafe).toThrow("bindings do not match");
  } finally {
    foreign.shutdown();
  }
});
