import { LvglRuntime, LV_COLOR_T_SIZE, LV_PART_MAIN, type UnsafePointer } from "liblvgl-wasm";

export async function exercise(bytes: ArrayBuffer, otherCore: ArrayBuffer) {
  const runtime = await LvglRuntime.load(bytes);
  const raw = runtime.unsafe;
  const wide: bigint = raw.lv_pow(18014398509494329n, 1);
  const display = runtime.createDisplay(80, 60);
  const screen = runtime.screen(display);
  const button = runtime.createButton(screen);
  const color: UnsafePointer = raw.lvw_alloc(LV_COLOR_T_SIZE);
  raw.lv_obj_set_size(button.handle, 40, 30);
  raw.lv_obj_set_pos(button.handle, 4, 6);
  raw.lv_obj_set_style_radius(button.handle, 0, LV_PART_MAIN);
  raw.lv_obj_set_style_border_width(button.handle, 0, LV_PART_MAIN);
  raw.lv_obj_set_style_shadow_width(button.handle, 0, LV_PART_MAIN);
  raw.lv_color_hex(color, 0x123456);
  raw.lv_obj_set_style_bg_color(button.handle, color, LV_PART_MAIN);
  const roundtrip = raw.lv_color_to_int(color);
  raw.lvw_free(color);
  raw.lv_refr_now(display.handle);
  const before = runtime.readFrame(display).rgba;
  let clicks = 0;
  const unsubscribe = button.on(runtime.clickedEvent, () => { clicks++; });
  const input = runtime.createPointer(display);
  input.push(20, 20, true);
  runtime.step(40);
  input.push(20, 20, false);
  runtime.step(40);
  unsubscribe();
  button.delete();
  raw.lv_refr_now(display.handle);
  const after = runtime.readFrame(display).rgba;
  const remaining = raw.lv_obj_get_child_count(screen.handle);
  display.destroy();
  runtime.shutdown();
  let closed = false;
  try { raw.lv_version_major(); } catch { closed = true; }
  const other = await LvglRuntime.load(otherCore);
  let mismatch = false;
  try { other.unsafe; } catch { mismatch = true; }
  other.shutdown();
  const offset = (15 * 80 + 15) * 4;
  return {
    identity: runtime.identity, wide, roundtrip, clicks, remaining, closed, mismatch,
    pixel: Array.from(before.slice(offset, offset + 3)),
    changed: before.some((value, index) => value !== after[index]),
  };
}
