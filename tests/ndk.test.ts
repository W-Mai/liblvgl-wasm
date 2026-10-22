import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LvglRuntime } from "../bindings/typescript/src/index.ts";
import { createWasiImports } from "../bindings/typescript/src/wasi.ts";
import fontFixture from "./fixtures/freetype/expected.json";

test("relocated NDK preserves the C/C++/Zig ABI and native callbacks", async () => {
  const output = await mkdtemp(join(tmpdir(), "lvw ndk host "));
  try {
    const process = Bun.spawn(["python3", "-B", "tests/ndk-consumer.py", output], {
      stdout: "pipe", stderr: "pipe",
    });
    const [status, stdout, stderr] = await Promise.all([
      process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
    ]);
    expect(status, stdout + stderr).toBe(0);
    const report = await Bun.file(join(output, "report.json")).json();
    expect(report.layouts).toBeGreaterThan(100);
    for (const language of ["c", "cpp", "zig"]) {
      const bytes = await Bun.file(join(output, `${language}.wasm`)).arrayBuffer();
      const baseline = await LvglRuntime.load(bytes);
      expect(() => baseline.unsafe).toThrow();
      baseline.shutdown();
      const sdk = await import(join(output, language, "bindings/typescript/src/index.ts"));
      const runtime = await sdk.LvglRuntime.load(bytes);
      expect(runtime.unsafe.lv_version_major()).toBe(9);
      const fontBytes = await Bun.file(`tests/fixtures/freetype/${fontFixture.font.file}`).bytes();
      fontBytes.set(fontFixture.cmap_recovery.bytes, fontFixture.cmap_recovery.offset);
      runtime.putResource("recovery.ttf", fontBytes);
      const raw = runtime.unsafe;
      const name = new TextEncoder().encode("W:recovery.ttf\0");
      const path = raw.lvw_alloc(name.length);
      new Uint8Array(raw.memory.buffer, path, name.length).set(name);
      const font = raw.lv_freetype_font_create(path, sdk.LV_FREETYPE_FONT_RENDER_MODE_BITMAP,
        16, sdk.LV_FREETYPE_FONT_STYLE_NORMAL);
      raw.lvw_free(path);
      expect(font).not.toBe(0);
      const glyph = raw.lvw_alloc(sdk.LV_FONT_GLYPH_DSC_T_SIZE);
      expect(raw.lv_font_get_glyph_dsc(font, glyph, 65, 0)).toBe(1);
      raw.lvw_free(glyph);
      raw.lv_freetype_font_delete(font);
      runtime.shutdown();

      const module = await WebAssembly.compile(bytes);
      let memory: WebAssembly.Memory;
      const lvw = Object.fromEntries(WebAssembly.Module.imports(module)
        .filter((item) => item.module === "lvw")
        .map((item) => [item.name, () => { throw new Error(`unexpected host callback: ${item.name}`); }]));
      const instance = await WebAssembly.instantiate(module, {
        lvw, wasi_snapshot_preview1: createWasiImports(() => memory),
      });
      memory = instance.exports.memory as WebAssembly.Memory;
      const api = instance.exports as unknown as Record<string, (...args: number[]) => number>;
      api._initialize!();
      expect(api.lvw_init!()).toBe(0);
      if (language === "cpp") expect(api.ndk_eh_test!()).toBe(42);
      if (language === "zig") {
        expect(api.zig_abi_layouts!()).toBe(7);
        expect(api.zig_abi_eh!()).toBe(42);
        const wide = instance.exports.zig_abi_wide as (value: bigint) => bigint;
        expect(wide(18014398509494329n)).toBe(18014398509494329n);
        expect(api.zig_abi_color!(0x123456)).toBe(0x123456);
        expect(api.zig_abi_float!(1.75)).toBe(1.75);
      }
      const display = api.lvw_display_create!(320, 240, 1);
      expect(display).not.toBe(0);
      api.lvw_demo_create!(display);
      const screen = api.lv_display_get_screen_active!(display);
      const button = api.lv_obj_get_child!(screen, 0);
      const label = api.lv_obj_get_child!(button, 0);
      const input = api.lvw_indev_create!(display, 1);
      const packet = api.lvw_alloc!(32);
      const frame = api.lvw_alloc!(48);
      const step = api.lvw_alloc!(16);
      for (const [pointer, size] of [[frame, 48], [step, 16]]) {
        const view = new DataView(memory.buffer);
        view.setUint32(pointer!, size!, true);
        view.setUint32(pointer! + 4, 1, true);
      }
      function text(): string {
        const start = api.lv_label_get_text!(label);
        const bytes = new Uint8Array(memory.buffer);
        return new TextDecoder().decode(bytes.subarray(start, bytes.indexOf(0, start)));
      }
      function pixels(): Uint8Array {
        api.lv_refr_now!(display);
        expect(api.lvw_frame_get!(display, frame)).toBe(0);
        const view = new DataView(memory.buffer);
        return new Uint8Array(memory.buffer, view.getUint32(frame + 8, true),
          view.getUint32(frame + 12, true)).slice();
      }
      expect(text()).toBe("Click me");
      const before = pixels();
      if (language === "zig") {
        expect(new DataView(memory.buffer).getUint32(frame + 28, true)).toBe(1);
        expect(new DataView(before.buffer).getUint32(0, true) & 0xffffff).toBe(0x123456);
      }
      for (const state of [1, 0]) {
        const view = new DataView(memory.buffer);
        [32, 1, 1, 160, 120, state, 0, 0].forEach((value, index) => view.setUint32(packet + index * 4, value, true));
        expect(api.lvw_indev_push!(input, packet, 32)).toBe(0);
        expect(api.lvw_step!(40, step)).toBe(0);
      }
      expect(text()).toBe("Clicked");
      expect(pixels()).not.toEqual(before);
      api.lv_obj_delete!(button);
      expect(api.lv_obj_get_child_count!(screen)).toBe(0);
      expect(pixels()).not.toEqual(before);
      for (const pointer of [packet, frame, step]) api.lvw_free!(pointer);
      expect(api.lvw_display_destroy!(display)).toBe(0);
      expect(api.lvw_shutdown!()).toBe(0);
    }
  } finally {
    await rm(output, { recursive: true, force: true });
  }
}, 180_000);
