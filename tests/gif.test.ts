import { expect, test } from "bun:test";
import {
  LV_COLOR_T_SIZE, LV_EVENT_READY, LV_OPA_COVER, LV_PART_MAIN,
  LvglRuntime, ObjectRef, type Frame,
} from "../bindings/typescript/src/index.ts";
import fixture from "./fixtures/gif/expected.json";

async function load() {
  const runtime = await LvglRuntime.load(await Bun.file("target/wasm/liblvgl.wasm").arrayBuffer());
  const raw = runtime.unsafe;
  const display = runtime.createDisplay(48, 32);
  const screen = runtime.screen(display);
  const color = raw.lvw_alloc(LV_COLOR_T_SIZE);
  const [red, green, blue] = fixture.background;
  raw.lv_color_hex(color, (red! << 16) | (green! << 8) | blue!);
  raw.lv_obj_set_style_bg_color(screen.handle, color, LV_PART_MAIN);
  raw.lv_obj_set_style_bg_opa(screen.handle, LV_OPA_COVER, LV_PART_MAIN);
  raw.lvw_free(color);
  for (const sample of [fixture, fixture.still]) {
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
  function create(x = 6, y = 5): ObjectRef {
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

test("GIF playback preserves every frame deadline and querying frame count does not alter playback", async () => {
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

test("GIF widgets keep separate clocks and support pause, resume, finite playback and restart", async () => {
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
    expect(raw.lv_gif_is_loaded(gif.handle)).toBe(0);
    runtime.step(1000);
    pixels(frame(), null);
    raw.lv_gif_set_src(gif.handle, playback);
    expect(raw.lv_gif_is_loaded(gif.handle)).toBe(1);
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

test("READY notifications preserve deletion, replacement timers, source changes and restart", async () => {
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
