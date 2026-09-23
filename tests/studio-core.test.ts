import { expect, test } from "bun:test";
import { inspectCore } from "../studio/src/core.ts";

test("studio accepts the built core and rejects missing bridge exports", async () => {
  const bytes = await Bun.file("target/wasm/liblvgl.wasm").arrayBuffer();
  const info = await inspectCore(bytes);
  expect(info.exports).toContain("lvw_step");
  expect(info.imports).toContain("lvw.event");

  const emptyModule = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  expect(inspectCore(emptyModule)).rejects.toThrow("missing required exports");
});
