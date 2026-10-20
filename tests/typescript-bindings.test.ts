import { expect, test } from "bun:test";
import { LvglRuntime, bindingIdentity } from "../bindings/typescript/src/index.ts";
import { apiExports, createUnsafeLvglApi } from "../target/typescript/raw.ts";

test("generated TypeScript methods cover exactly the supported exports", async () => {
  const report = await Bun.file("target/wasm/api.json").json() as {
    declarations: { name: string; export_name: string | null }[];
  };
  const expected = Object.fromEntries(report.declarations
    .filter((entry) => entry.export_name !== null)
    .map((entry) => [entry.name, entry.export_name]));
  expect(apiExports).toEqual(expected);
  expect(bindingIdentity).toEqual(await Bun.file("target/wasm/api-verification.json").json());
  expect(Object.isFrozen(bindingIdentity)).toBe(true);
  expect(Object.isFrozen(apiExports)).toBe(true);
  const calls: { name: string; args: unknown[] }[] = [];
  const exports = Object.fromEntries(Object.values(apiExports).map((name) => [
    name, (...args: unknown[]) => { calls.push({ name, args }); return 7; },
  ]));
  let guards = 0;
  const raw = createUnsafeLvglApi(exports, () => { guards++; });
  expect(Object.isFrozen(raw)).toBe(true);
  expect(Object.keys(raw).sort()).toEqual(Object.keys(expected).sort());
  for (const name of Object.keys(apiExports) as (keyof typeof apiExports)[]) {
    const call = raw[name] as (...args: (number | bigint)[]) => unknown;
    expect(call(3, 5n)).toBe(7);
    expect(calls.at(-1)).toEqual({ name: apiExports[name], args: [3, 5n] });
  }
  expect(guards).toBe(Object.keys(expected).length);
});

test("generated raw calls use the matching core's objects, memory, and aggregate ABI", async () => {
  const bytes = await Bun.file("target/wasm/liblvgl.wasm").bytes();
  const padded = new Uint8Array(bytes.length + 17);
  padded.set(bytes, 9);
  const view = new DataView(padded.buffer, 9, bytes.length);
  const loading = LvglRuntime.load(view);
  padded.fill(0);
  const runtime = await loading;
  const report = await Bun.file("target/wasm/api.json").json() as {
    types: Record<string, { kind: string; name?: string; layout: { size: number | null } }>;
    constants: { name: string; value?: string }[];
  };
  const layout = Object.values(report.types).find(
    (node) => node.kind === "alias" && node.name === "lv_color_t",
  )!;
  const mainPart = Number(report.constants.find((entry) => entry.name === "LV_PART_MAIN")!.value);
  const api = runtime.unsafe;
  const pow = api.lv_pow;
  const allocate = api.lvw_alloc;
  try {
    expect(Object.isFrozen(api)).toBe(true);
    expect(api).toBe(runtime.unsafe);
    expect(pow(18014398509494329n, 1)).toBe(18014398509494329n);
    const display = runtime.createDisplay(80, 60);
    const screen = api.lv_display_get_screen_active(display.handle);
    const button = api.lv_button_create(screen);
    const label = api.lv_label_create(button);
    api.lv_obj_set_size(button, 40, 30);
    api.lv_obj_set_pos(button, 4, 6);
    const color = allocate(layout.layout.size!);
    const text = new TextEncoder().encode("Raw LVGL\0");
    const textPointer = allocate(text.length);
    expect(color).toBeGreaterThan(0);
    expect(textPointer).toBeGreaterThan(0);
    try {
      api.lv_color_hex(color, 0x123456);
      expect(api.lv_color_to_int(color)).toBe(0x123456);
      api.lv_obj_set_style_bg_color(button, color, mainPart);
      api.lv_obj_get_style_bg_color(color, button, mainPart);
      expect(api.lv_color_to_int(color)).toBe(0x123456);
      new Uint8Array(api.memory.buffer, textPointer, text.length).set(text);
      api.lv_label_set_text(label, textPointer);
      const stored = api.lv_label_get_text(label);
      expect([...new Uint8Array(api.memory.buffer, stored, text.length)]).toEqual([...text]);
      runtime.step(50);
      expect(runtime.readFrame(display).width).toBe(80);
    } finally {
      api.lvw_free(textPointer);
      api.lvw_free(color);
    }
    display.destroy();
  } finally {
    runtime.shutdown();
  }
  expect(() => pow(2n, 3)).toThrow("closed");
  expect(() => allocate(4)).toThrow("closed");
  expect(() => api.memory).toThrow("closed");
  expect(() => runtime.unsafe).toThrow("closed");
});

test("a different core keeps bridge access and rejects generated raw bindings", async () => {
  const bytes = await Bun.file("target/wasm/liblvgl.wasm").bytes();
  const name = new TextEncoder().encode("different-core");
  const section = new Uint8Array([0, name.length + 1, name.length, ...name]);
  const changed = new Uint8Array(bytes.length + section.length);
  changed.set(bytes);
  changed.set(section, bytes.length);
  const runtime = await LvglRuntime.load(changed);
  try {
    const display = runtime.createDisplay(80, 60);
    runtime.step(50);
    expect(runtime.readFrame(display).width).toBe(80);
    expect(() => runtime.unsafe).toThrow("bindings do not match");
    display.destroy();
  } finally {
    runtime.shutdown();
  }
});
