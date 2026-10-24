import { expect, test } from "bun:test";
import type { Frame, ObjectRef as ObjectType } from "../bindings/typescript/src/index.ts";
import fixture from "./fixtures/gif/expected.json";
const sdk = await import(Bun.env.LVW_TEST_TS_RUNTIME ?? "../bindings/typescript/src/index.ts") as
  typeof import("../bindings/typescript/src/index.ts");
const { LV_COLOR_T_SIZE, LV_EVENT_READY, LV_OPA_COVER, LV_PART_MAIN, LvglRuntime, ObjectRef } = sdk;
const legacy = [0, 1].includes(Number(sdk.LVGL_VERSION_MINOR));

async function load() {
  const runtime = await LvglRuntime.load(await Bun.file(Bun.env.LVW_TEST_CORE ?? "target/wasm/liblvgl.wasm").arrayBuffer());
  const raw = runtime.unsafe;
  const display = runtime.createDisplay(48, 32);
  const screen = runtime.screen(display);
  const color = raw.lvw_alloc(LV_COLOR_T_SIZE);
  const [red, green, blue] = fixture.background;
  raw.lv_color_hex(color, (red! << 16) | (green! << 8) | blue!);
  raw.lv_obj_set_style_bg_color(screen.handle, color, LV_PART_MAIN);
  raw.lv_obj_set_style_bg_opa(screen.handle, LV_OPA_COVER, LV_PART_MAIN);
  raw.lvw_free(color);
  for (const sample of [fixture, fixture.still, fixture.single_pass, fixture.repeat_once, fixture.pixel]) {
    const bytes = await Bun.file(`tests/fixtures/gif/${sample.file}`).bytes();
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(sample.sha256);
    runtime.putResource(sample.file, bytes);
  }
  const paths: number[] = [];
  function path(name: string): number {
    const bytes = new TextEncoder().encode(`W:${name}\0`);
    const pointer = raw.lvw_alloc(bytes.length);
    new Uint8Array(raw.memory.buffer, pointer, bytes.length).set(bytes);
    paths.push(pointer);
    return pointer;
  }
  const playback = path(fixture.file);
  const still = path(fixture.still.file);
  function create(x = 6, y = 5): ObjectType {
    const object = new ObjectRef(runtime, raw.lv_gif_create(screen.handle));
    object.setPosition(x, y);
    return object;
  }
  function frame(): Frame {
    // Display refresh does not advance the GIF timer or change its natural deadline.
    raw.lv_refr_now(display.handle);
    return runtime.readFrame(display);
  }
  function close(): void {
    // Native GIF objects borrow their source pointers beyond lv_gif_set_src().
    display.destroy();
    for (const pointer of paths) raw.lvw_free(pointer);
    runtime.shutdown();
  }
  return { runtime, raw, playback, still, path, create, frame, close };
}

function pixels(frame: Frame, index: number | null, x = 6, y = 5): void {
  for (let row = 0; row < fixture.height; row++) {
    for (let column = 0; column < fixture.width; column++) {
      const color = index === null ? undefined
        : fixture.palette[fixture.frames[index]!.indices[row * fixture.width + column]!]!;
      const expected = color && color[3] !== 0 ? color : [...fixture.background, 255];
      const offset = ((y + row) * frame.width + x + column) * 4;
      expect([...frame.rgba.subarray(offset, offset + 4)], `GIF frame ${index}, pixel (${column}, ${row})`)
        .toEqual(expected);
    }
  }
}

test.skipIf(legacy)("GIF playback preserves every frame deadline and querying frame count does not alter playback", async () => {
  const { runtime, raw, playback, create, frame, close } = await load();
  const gif = create();
  let now = 0;
  const readyAt: number[] = [];
  gif.on(LV_EVENT_READY, () => { readyAt.push(now); });
  raw.lv_gif_set_src(gif.handle, playback);
  expect(raw.lv_gif_is_loaded(gif.handle)).toBe(1);
  expect(raw.lv_image_get_src_width(gif.handle)).toBe(fixture.width);
  expect(raw.lv_image_get_src_height(gif.handle)).toBe(fixture.height);
  for (const [deadline, expectedFrame, expectedIndex] of [
    [0, 0, 1], [37, 0, 1], [79, 0, 1], [80, 1, 2], [137, 1, 2], [199, 1, 2],
    [200, 2, 0], [237, 2, 0], [359, 2, 0], [360, 0, 1],
    [439, 0, 1], [440, 1, 2], [559, 1, 2], [560, 2, 0], [719, 2, 0], [720, 0, 1],
  ] as const) {
    const elapsed = deadline - now;
    now = deadline;
    runtime.step(elapsed);
    expect(raw.lv_gif_get_frame_count(gif.handle)).toBe(fixture.frames.length);
    expect(raw.lv_gif_get_current_frame_index(gif.handle)).toBe(expectedIndex);
    expect(raw.lv_gif_get_loop_count(gif.handle)).toBe(0);
    pixels(frame(), expectedFrame);
  }
  expect(readyAt).toEqual([200, 560]);
  close();
});

test.skipIf(legacy)("GIF widgets keep separate clocks and support pause, resume, finite playback and restart", async () => {
  const { runtime, raw, playback, create, frame, close } = await load();
  const first = create();
  raw.lv_gif_set_src(first.handle, playback);
  raw.lv_gif_set_loop_count(first.handle, 1);
  let ready = 0;
  first.on(LV_EVENT_READY, () => { ready++; });
  runtime.step(41);
  const second = create(26, 15);
  raw.lv_gif_set_src(second.handle, playback);
  runtime.step(39);
  pixels(frame(), 1);
  pixels(frame(), 0, 26, 15);
  runtime.step(40);
  pixels(frame(), 0, 26, 15);
  runtime.step(1);
  pixels(frame(), 1, 26, 15);
  raw.lv_gif_pause(first.handle);
  runtime.step(200);
  pixels(frame(), 1);
  pixels(frame(), 2, 26, 15);
  expect(ready).toBe(0);
  raw.lv_gif_resume(first.handle);
  runtime.step(0);
  pixels(frame(), 2);
  expect(ready).toBe(1);
  expect(raw.lv_gif_get_loop_count(first.handle)).toBe(1);
  runtime.step(500);
  pixels(frame(), 2);
  expect(ready).toBe(1);

  raw.lv_gif_restart(first.handle);
  expect(raw.lv_gif_get_current_frame_index(first.handle)).toBe(0);
  expect(raw.lv_gif_get_loop_count(first.handle)).toBe(-1);
  raw.lv_gif_set_loop_count(first.handle, 1);
  runtime.step(159);
  expect(raw.lv_gif_get_current_frame_index(first.handle)).toBe(0);
  expect(ready).toBe(1);
  runtime.step(1);
  pixels(frame(), 0);
  runtime.step(80);
  pixels(frame(), 1);
  runtime.step(120);
  pixels(frame(), 2);
  expect(ready).toBe(2);
  runtime.step(500);
  pixels(frame(), 2);
  expect(ready).toBe(2);
  close();
});

test("clearing or rejecting GIF sources stops their timers and valid resources remain reusable", async () => {
  const { runtime, raw, playback, path, create, frame, close } = await load();
  runtime.putResource("bad.gif", new Uint8Array(32));
  const gif = create();
  raw.lv_gif_set_src(gif.handle, playback);
  for (const source of [0, path("bad.gif"), path("missing.gif")]) {
    raw.lv_gif_set_src(gif.handle, source);
    if (!legacy) expect(raw.lv_gif_is_loaded(gif.handle)).toBe(0);
    expect(raw.lv_image_get_src(gif.handle)).toBe(0);
    runtime.step(1000);
    pixels(frame(), null);
    raw.lv_gif_set_src(gif.handle, playback);
    if (!legacy) expect(raw.lv_gif_is_loaded(gif.handle)).toBe(1);
    pixels(frame(), 0);
    runtime.step(80);
    pixels(frame(), 1);
  }
  gif.delete();
  runtime.step(1000);
  pixels(frame(), null);
  const replacement = create();
  raw.lv_gif_set_src(replacement.handle, playback);
  pixels(frame(), 0);
  runtime.step(80);
  pixels(frame(), 1);
  close();
});

test.skipIf(legacy)("READY notifications preserve deletion, replacement timers, source changes and restart", async () => {
  for (const action of ["delete", "replace", "restart", "synchronous delete", "synchronous replace"] as const) {
    const { runtime, raw, playback, still, create, frame, close } = await load();
    const gif = create();
    let ready = 0;
    let ticks = 0;
    gif.on(LV_EVENT_READY, () => {
      ready++;
      if (ready !== 1) return;
      if (action === "delete" || action === "synchronous delete") {
        gif.delete();
        runtime.createTimer(5, () => { ticks++; });
      } else if (action === "restart") raw.lv_gif_restart(gif.handle);
      else raw.lv_gif_set_src(gif.handle, playback);
    });
    raw.lv_gif_set_src(gif.handle, action.startsWith("synchronous") ? still : playback);
    if (!action.startsWith("synchronous")) {
      raw.lv_gif_set_loop_count(gif.handle, 1);
      runtime.step(80);
      runtime.step(120);
    }
    expect(ready).toBe(1);
    if (action === "delete" || action === "synchronous delete") {
      expect(() => gif.setSize(9, 7)).toThrow("invalid");
      runtime.step(5);
      expect(ticks).toBe(1);
      runtime.step(5);
      expect(ticks).toBe(2);
      pixels(frame(), null);
    } else if (action === "restart") {
      expect(raw.lv_gif_get_loop_count(gif.handle)).toBe(-1);
      expect(raw.lv_gif_get_current_frame_index(gif.handle)).toBe(0);
      runtime.step(159);
      expect(raw.lv_gif_get_current_frame_index(gif.handle)).toBe(0);
      expect(ready).toBe(1);
      runtime.step(1);
      pixels(frame(), 0);
      runtime.step(80);
      pixels(frame(), 1);
    } else {
      expect(raw.lv_gif_get_loop_count(gif.handle)).toBe(0);
      pixels(frame(), 0);
      runtime.step(79);
      pixels(frame(), 0);
      runtime.step(1);
      pixels(frame(), 1);
    }
    close();
  }
});

test.skipIf(!legacy)("legacy GIF deadlines, separate clocks, pause and native finite loops preserve pixels", async () => {
  const { runtime, raw, playback, path, create, frame, close } = await load();
  const gif = create();
  expect(raw.lv_gif_is_loaded).toBeUndefined();
  expect(raw.lv_gif_get_frame_count).toBeUndefined();
  let ready = 0;
  gif.on(LV_EVENT_READY, () => { ready++; });
  raw.lv_gif_set_src(gif.handle, playback);
  let now = 0;
  for (const [deadline, index] of [[0, 0], [37, 0], [79, 0], [80, 1], [199, 1], [200, 2], [359, 2], [360, 0]]) {
    runtime.step(deadline! - now);
    now = deadline!;
    pixels(frame(), index!);
  }
  expect(ready).toBe(0);
  const other = create(26, 15);
  runtime.step(40);
  raw.lv_gif_set_src(other.handle, playback);
  runtime.step(40);
  pixels(frame(), 1);
  pixels(frame(), 0, 26, 15);
  runtime.step(40);
  pixels(frame(), 1, 26, 15);
  raw.lv_gif_pause(gif.handle);
  runtime.step(200);
  pixels(frame(), 1);
  pixels(frame(), 2, 26, 15);
  raw.lv_gif_resume(gif.handle);
  runtime.step(0);
  pixels(frame(), 2);
  other.delete();
  for (const [source, cycles] of [[fixture.single_pass.file, 1], [fixture.repeat_once.file, 2]] as const) {
    const before = ready;
    raw.lv_gif_set_src(gif.handle, path(source));
    for (let cycle = 0; cycle < cycles; cycle++) {
      pixels(frame(), 0);
      runtime.step(80); pixels(frame(), 1);
      runtime.step(120); pixels(frame(), 2);
      runtime.step(159); pixels(frame(), 2);
      expect(ready).toBe(before);
      runtime.step(1);
    }
    expect(ready).toBe(before + 1);
    pixels(frame(), 2);
    runtime.step(500);
    pixels(frame(), 2);
  }
  raw.lv_gif_restart(gif.handle);
  runtime.step(159); pixels(frame(), 2);
  runtime.step(1); pixels(frame(), 0);
  runtime.step(80); pixels(frame(), 1);
  close();
});

test.skipIf(!legacy)("legacy READY can delete, replace or restart without touching old native state", async () => {
  for (const action of ["delete", "replace", "restart"] as const) {
    const { runtime, raw, playback, path, create, frame, close } = await load();
    const gif = create();
    let ready = 0, ticks = 0;
    gif.on(LV_EVENT_READY, () => {
      if (++ready !== 1) return;
      if (action === "delete") {
        gif.delete();
        if (raw.lvw_timer_create) runtime.createTimer(5, () => { ticks++; });
      } else if (action === "replace") raw.lv_gif_set_src(gif.handle, playback);
      else raw.lv_gif_restart(gif.handle);
    });
    raw.lv_gif_set_src(gif.handle, path(fixture.single_pass.file));
    runtime.step(80); runtime.step(120); runtime.step(160);
    expect(ready).toBe(1);
    if (action === "delete") {
      expect(() => gif.setSize(9, 7)).toThrow("invalid");
      runtime.step(5); runtime.step(5);
      expect(ticks).toBe(raw.lvw_timer_create ? 2 : 0);
      pixels(frame(), null);
    } else if (action === "replace") {
      pixels(frame(), 0);
      runtime.step(79); pixels(frame(), 0);
      runtime.step(1); pixels(frame(), 1);
    } else {
      pixels(frame(), 2);
      runtime.step(159); pixels(frame(), 2);
      runtime.step(1); pixels(frame(), 0);
    }
    close();
  }
});

test.skipIf(!legacy)("legacy GIF variable bytes and resized sources retain correct cache and memory lifetimes", async () => {
  const { runtime, raw, playback, path, create, frame, close } = await load();
  const gif = create();
  const bytes = await Bun.file(`tests/fixtures/gif/${fixture.file}`).bytes();
  const descriptor = raw.lvw_alloc(sdk.LV_IMAGE_DSC_T_SIZE);
  const data = raw.lvw_alloc(bytes.length);
  new Uint8Array(raw.memory.buffer, data, bytes.length).set(bytes);
  new Uint8Array(raw.memory.buffer, descriptor, sdk.LV_IMAGE_DSC_T_SIZE).fill(0);
  const view = new DataView(raw.memory.buffer);
  for (const [name, value] of [["data", data], ["data_size", bytes.length]] as const) {
    const field = sdk.LV_IMAGE_DSC_T_FIELDS.find((field) => field.name === name)!;
    view.setUint32(descriptor + field.bit_offset / 8, value, true);
  }
  raw.lv_gif_set_src(gif.handle, descriptor);
  pixels(frame(), 0);
  runtime.step(80); pixels(frame(), 1);
  raw.lv_gif_set_src(gif.handle, path(fixture.pixel.file));
  raw.lv_obj_update_layout(gif.handle);
  expect([raw.lv_obj_get_width(gif.handle), raw.lv_obj_get_height(gif.handle)]).toEqual([1, 1]);
  const output = frame();
  const offset = (5 * output.width + 6) * 4;
  expect([...output.rgba.subarray(offset, offset + 4)]).toEqual([255, 0, 0, 255]);
  raw.lv_gif_set_src(gif.handle, playback);
  raw.lv_obj_update_layout(gif.handle);
  expect([raw.lv_obj_get_width(gif.handle), raw.lv_obj_get_height(gif.handle)]).toEqual([9, 7]);
  pixels(frame(), 0);
  for (const [name, invalid] of [["truncated.gif", bytes.subarray(0, 13)],
    ["zero-width.gif", Uint8Array.from(bytes, (byte, index) => index === 6 || index === 7 ? 0 : byte)]] as const) {
    runtime.putResource(name, invalid);
    raw.lv_gif_set_src(gif.handle, path(name));
    expect(raw.lv_image_get_src(gif.handle)).toBe(0);
    runtime.step(1000); pixels(frame(), null);
    raw.lv_gif_set_src(gif.handle, playback); pixels(frame(), 0);
  }
  gif.delete();
  raw.lvw_free(descriptor); raw.lvw_free(data);
  runtime.step(1000); pixels(frame(), null);
  close();
});
