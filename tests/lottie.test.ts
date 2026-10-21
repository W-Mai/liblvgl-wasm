import { expect, test } from "bun:test";
import {
  LV_ANIM_REPEAT_INFINITE, LV_COLOR_FORMAT_ARGB8888,
  LV_COLOR_FORMAT_ARGB8888_PREMULTIPLIED, LV_COLOR_T_SIZE, LV_DRAW_BUF_ALIGN,
  LV_DRAW_BUF_T_FIELDS, LV_IMAGE_FLAGS_PREMULTIPLIED, LV_IMAGE_HEADER_T_FIELDS,
  LV_OPA_COVER, LV_PART_MAIN, LV_STRIDE_AUTO,
  LvglRuntime, ObjectRef, type Frame,
} from "../bindings/typescript/src/index.ts";
import fixture from "./fixtures/lottie/expected.json";
import animation from "./fixtures/lottie/translation-opacity.json";

type Raw = LvglRuntime["unsafe"];
type Checkpoint = typeof fixture.checkpoints[number];
type Placement = { checkpoint: Checkpoint; x: number; y: number; foreground?: number[] };

function copy(raw: Raw, bytes: Uint8Array): number {
  const pointer = raw.lvw_alloc(bytes.length + 1);
  expect(pointer).not.toBe(0);
  new Uint8Array(raw.memory.buffer, pointer, bytes.length + 1).set([...bytes, 0]);
  return pointer;
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortedKeys(entry)]));
  }
  return value;
}

async function load() {
  const runtime = await LvglRuntime.load(await Bun.file("target/wasm/liblvgl.wasm").arrayBuffer());
  const raw = runtime.unsafe;
  const display = runtime.createDisplay(80, 40);
  const screen = runtime.screen(display);
  const color = raw.lvw_alloc(LV_COLOR_T_SIZE);
  raw.lv_color_hex(color, (fixture.background[0]! << 16) | (fixture.background[1]! << 8) | fixture.background[2]!);
  raw.lv_obj_set_style_bg_color(screen.handle, color, LV_PART_MAIN);
  raw.lv_obj_set_style_bg_opa(screen.handle, LV_OPA_COVER, LV_PART_MAIN);
  raw.lvw_free(color);
  const source = await Bun.file(`tests/fixtures/lottie/${fixture.source.file}`).bytes();
  expect(new Bun.CryptoHasher("sha256").update(source).digest("hex")).toBe(fixture.source.sha256);
  for (const checkpoint of fixture.checkpoints) {
    expect(checkpoint.rgba_min.length).toBe(fixture.source.width * fixture.source.height);
    expect(checkpoint.rgba_max.length).toBe(fixture.source.width * fixture.source.height);
  }
  const buffers: number[] = [];
  const drawBuffers: number[] = [];
  function buffer(): number {
    const stride = raw.lv_draw_buf_width_to_stride(fixture.source.width, LV_COLOR_FORMAT_ARGB8888_PREMULTIPLIED);
    const size = stride * fixture.source.height + LV_DRAW_BUF_ALIGN;
    const pointer = raw.lvw_alloc(size);
    expect(pointer).not.toBe(0);
    new Uint8Array(raw.memory.buffer, pointer, size).fill(0);
    buffers.push(pointer);
    return pointer;
  }
  function drawBuffer(): number {
    const pointer = raw.lv_draw_buf_create(fixture.source.width, fixture.source.height, LV_COLOR_FORMAT_ARGB8888, LV_STRIDE_AUTO);
    expect(pointer).not.toBe(0);
    drawBuffers.push(pointer);
    return pointer;
  }
  function create(x = 4, y = 4): ObjectRef {
    const object = new ObjectRef(runtime, raw.lv_lottie_create(screen.handle));
    object.setPosition(x, y);
    return object;
  }
  function setData(object: ObjectRef, bytes = source): void {
    const pointer = copy(raw, bytes);
    raw.lv_lottie_set_src_data(object.handle, pointer, bytes.length);
    // The native loader owns a copy when the setter returns.
    new Uint8Array(raw.memory.buffer, pointer, bytes.length + 1).fill(0x78);
    raw.lvw_free(pointer);
  }
  function setFile(object: ObjectRef, name: string): void {
    const bytes = new TextEncoder().encode(`W:${name}`);
    const pointer = copy(raw, bytes);
    raw.lv_lottie_set_src_file(object.handle, pointer);
    new Uint8Array(raw.memory.buffer, pointer, bytes.length + 1).fill(0x78);
    raw.lvw_free(pointer);
  }
  function frame(): Frame {
    raw.lv_refr_now(display.handle);
    return runtime.readFrame(display);
  }
  function close(): void {
    // Caller-owned pixel storage outlives every widget that borrows it.
    display.destroy();
    for (const pointer of buffers) raw.lvw_free(pointer);
    for (const pointer of drawBuffers) raw.lv_draw_buf_destroy(pointer);
    runtime.shutdown();
  }
  return { runtime, raw, source, buffer, drawBuffer, create, setData, setFile, frame, close };
}

function pixels(frame: Frame, placements: Placement[]): void {
  expect([frame.width, frame.height]).toEqual([80, 40]);
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const placed = placements.find(({ x: left, y: top }) =>
        x >= left && y >= top && x < left + fixture.source.width && y < top + fixture.source.height);
      const index = placed ? (y - placed.y) * fixture.source.width + x - placed.x : 0;
      let lower = placed?.checkpoint.rgba_min[index] ?? [...fixture.background, 255];
      let upper = placed?.checkpoint.rgba_max[index] ?? [...fixture.background, 255];
      const untouched = fixture.background.every((value, channel) => lower[channel] === value && upper[channel] === value);
      if (placed?.foreground && !untouched) {
        const opacity = placed.checkpoint.opacity;
        lower = placed.foreground.map((value, channel) =>
          Math.floor((value * opacity + fixture.background[channel]! * (255 - opacity)) / 255));
        upper = lower;
      }
      const tolerance = untouched ? 0 : placed!.checkpoint.tolerance;
      const start = (y * frame.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const actual = frame.rgba[start + channel]!;
        const message = `Lottie frame ${placed?.checkpoint.rendered_frame ?? "background"} (${x},${y}) channel ${channel}: ${actual} outside ${lower[channel]}..${upper[channel]}`;
        expect(actual, message).toBeGreaterThanOrEqual(lower[channel]! - tolerance);
        expect(actual, message).toBeLessThanOrEqual(upper[channel]! + tolerance);
      }
      expect(frame.rgba[start + 3]).toBe(255);
    }
  }
}

function premultiplied(raw: Raw, object: ObjectRef): void {
  const drawBuffer = raw.lv_canvas_get_draw_buf(object.handle);
  expect(drawBuffer).not.toBe(0);
  expect(raw.lv_draw_buf_has_flag(drawBuffer, LV_IMAGE_FLAGS_PREMULTIPLIED)).toBe(1);
  const header = drawBuffer + LV_DRAW_BUF_T_FIELDS.find((field) => field.name === "header")!.bit_offset / 8;
  const format = LV_IMAGE_HEADER_T_FIELDS.find((field) => field.name === "cf")!;
  expect(format.bit_width).toBe(8);
  expect(new DataView(raw.memory.buffer).getUint8(header + format.bit_offset / 8))
    .toBe(LV_COLOR_FORMAT_ARGB8888_PREMULTIPLIED);
  expect([raw.lv_image_get_src_width(object.handle), raw.lv_image_get_src_height(object.handle)])
    .toEqual([fixture.source.width, fixture.source.height]);
}

test("Lottie native animation controls preserve mathematical frames, pause time and finite completion", async () => {
  const { runtime, raw, buffer, create, setData, frame, close } = await load();
  const running = raw.lv_anim_count_running();
  const object = create();
  raw.lv_lottie_set_buffer(object.handle, fixture.source.width, fixture.source.height, buffer());
  setData(object);
  premultiplied(raw, object);
  const anim = raw.lv_lottie_get_anim(object.handle);
  expect(anim).not.toBe(0);
  expect(raw.lv_anim_get_time(anim)).toBe(fixture.source.duration_ms);
  expect(raw.lv_anim_get_repeat_count(anim) >>> 0).toBe(LV_ANIM_REPEAT_INFINITE);
  raw.lv_anim_set_repeat_delay(anim, 250);
  let active = 0;
  for (const checkpoint of fixture.checkpoints) {
    runtime.step(checkpoint.active_ms - active);
    active = checkpoint.active_ms;
    pixels(frame(), [{ checkpoint, x: 4, y: 4 }]);
  }
  // The exclusive out frame maps to frame 15 until the repeat delay ends.
  runtime.step(125);
  pixels(frame(), [{ checkpoint: fixture.checkpoints[4]!, x: 4, y: 4 }]);
  runtime.step(125);
  pixels(frame(), [{ checkpoint: fixture.checkpoints[0]!, x: 4, y: 4 }]);
  runtime.step(250);
  raw.lv_anim_pause(anim);
  expect(raw.lv_anim_is_paused(anim)).toBe(1);
  runtime.step(250);
  pixels(frame(), [{ checkpoint: fixture.checkpoints[1]!, x: 4, y: 4 }]);
  raw.lv_anim_resume(anim);
  expect(raw.lv_anim_is_paused(anim)).toBe(0);
  runtime.step(250);
  pixels(frame(), [{ checkpoint: fixture.checkpoints[2]!, x: 4, y: 4 }]);
  raw.lv_anim_set_repeat_count(anim, 1);
  runtime.step(500);
  pixels(frame(), [{ checkpoint: fixture.checkpoints[4]!, x: 4, y: 4 }]);
  expect(raw.lv_lottie_get_anim(object.handle)).toBe(0);
  expect(raw.lv_anim_count_running()).toBe(running);
  runtime.step(250);
  pixels(frame(), [{ checkpoint: fixture.checkpoints[4]!, x: 4, y: 4 }]);
  setData(object);
  const restarted = raw.lv_lottie_get_anim(object.handle);
  expect(restarted).not.toBe(0);
  expect(raw.lv_anim_get_time(restarted)).toBe(fixture.source.duration_ms);
  expect(raw.lv_anim_get_repeat_count(restarted) >>> 0).toBe(LV_ANIM_REPEAT_INFINITE);
  pixels(frame(), [{ checkpoint: fixture.checkpoints[0]!, x: 4, y: 4 }]);
  runtime.step(250);
  pixels(frame(), [{ checkpoint: fixture.checkpoints[1]!, x: 4, y: 4 }]);
  raw.lv_anim_delete_all();
  expect(raw.lv_lottie_get_anim(object.handle)).toBe(0);
  runtime.step(250);
  pixels(frame(), [{ checkpoint: fixture.checkpoints[1]!, x: 4, y: 4 }]);
  setData(object);
  expect(raw.lv_lottie_get_anim(object.handle)).not.toBe(0);
  pixels(frame(), [{ checkpoint: fixture.checkpoints[0]!, x: 4, y: 4 }]);
  object.delete();
  expect(raw.lv_anim_count_running()).toBe(running);
  runtime.step(250);
  pixels(frame(), []);
  close();
});

test("Lottie sources are copied and replaced through data and W resources without losing valid playback on failure", async () => {
  const { runtime, raw, source, buffer, create, setData, setFile, frame, close } = await load();
  const uploaded = source.slice();
  runtime.putResource(fixture.source.file, uploaded);
  uploaded.fill(0);
  const alternative = structuredClone(animation);
  alternative.layers[0]!.shapes[1]!.c!.k = [0, 0.5, 1, 1];
  const changed = new TextEncoder().encode(JSON.stringify(sortedKeys(alternative)));
  const foreground = [0, 128, 255];
  runtime.putResource("changed.json", changed);
  const object = create();
  raw.lv_lottie_set_buffer(object.handle, fixture.source.width, fixture.source.height, buffer());
  setFile(object, fixture.source.file);
  pixels(frame(), [{ checkpoint: fixture.checkpoints[0]!, x: 4, y: 4 }]);
  runtime.step(250);
  raw.lv_anim_pause(raw.lv_lottie_get_anim(object.handle));
  setData(object, changed);
  expect(raw.lv_anim_is_paused(raw.lv_lottie_get_anim(object.handle))).toBe(0);
  pixels(frame(), [{ checkpoint: fixture.checkpoints[0]!, x: 4, y: 4, foreground }]);
  runtime.step(250);
  pixels(frame(), [{ checkpoint: fixture.checkpoints[1]!, x: 4, y: 4, foreground }]);
  for (const fail of [
    () => setData(object, new TextEncoder().encode("not json")),
    () => setData(object, source.subarray(0, Math.floor(source.length / 2))),
    () => setFile(object, "missing.json"),
  ]) {
    setFile(object, "changed.json");
    runtime.step(250);
    const anim = raw.lv_lottie_get_anim(object.handle);
    fail();
    expect(raw.lv_lottie_get_anim(object.handle)).toBe(anim);
    expect(raw.lv_anim_get_time(anim)).toBe(fixture.source.duration_ms);
    pixels(frame(), [{ checkpoint: fixture.checkpoints[1]!, x: 4, y: 4, foreground }]);
    runtime.step(250);
    pixels(frame(), [{ checkpoint: fixture.checkpoints[2]!, x: 4, y: 4, foreground }]);
  }
  setFile(object, fixture.source.file);
  pixels(frame(), [{ checkpoint: fixture.checkpoints[0]!, x: 4, y: 4 }]);
  object.delete();
  const replacement = create();
  raw.lv_lottie_set_buffer(replacement.handle, fixture.source.width, fixture.source.height, buffer());
  setFile(replacement, fixture.source.file);
  pixels(frame(), [{ checkpoint: fixture.checkpoints[0]!, x: 4, y: 4 }]);
  runtime.step(250);
  pixels(frame(), [{ checkpoint: fixture.checkpoints[1]!, x: 4, y: 4 }]);
  close();
});

test("Lottie instances keep separate clocks and retain their frames across buffer rebinding and deletion", async () => {
  const { runtime, raw, source, buffer, drawBuffer, create, setFile, frame, close } = await load();
  const running = raw.lv_anim_count_running();
  runtime.putResource("shared.JSON", source);
  const first = create();
  const pixelsBuffer = buffer();
  raw.lv_lottie_set_buffer(first.handle, fixture.source.width, fixture.source.height, pixelsBuffer);
  setFile(first, "shared.JSON");
  runtime.step(250);
  const second = create(44, 8);
  setFile(second, "shared.JSON");
  const draw = drawBuffer();
  raw.lv_lottie_set_draw_buf(second.handle, draw);
  pixels(frame(), [
    { checkpoint: fixture.checkpoints[1]!, x: 4, y: 4 },
    { checkpoint: fixture.checkpoints[0]!, x: 44, y: 8 },
  ]);
  runtime.step(250);
  pixels(frame(), [
    { checkpoint: fixture.checkpoints[2]!, x: 4, y: 4 },
    { checkpoint: fixture.checkpoints[1]!, x: 44, y: 8 },
  ]);
  raw.lv_anim_pause(raw.lv_lottie_get_anim(first.handle));
  runtime.step(250);
  const both = [
    { checkpoint: fixture.checkpoints[2]!, x: 4, y: 4 },
    { checkpoint: fixture.checkpoints[2]!, x: 44, y: 8 },
  ];
  pixels(frame(), both);
  const previous = raw.lv_canvas_get_draw_buf(second.handle);
  const unaligned = raw.lv_draw_buf_create(fixture.source.width, fixture.source.height, LV_COLOR_FORMAT_ARGB8888, 130);
  expect(unaligned).not.toBe(0);
  raw.lv_lottie_set_draw_buf(second.handle, unaligned);
  expect(raw.lv_canvas_get_draw_buf(second.handle)).toBe(previous);
  pixels(frame(), both);
  raw.lv_draw_buf_destroy(unaligned);
  for (let repeat = 0; repeat < 2; repeat++) {
    raw.lv_lottie_set_buffer(first.handle, fixture.source.width, fixture.source.height, pixelsBuffer);
    raw.lv_lottie_set_draw_buf(second.handle, draw);
    premultiplied(raw, first);
    premultiplied(raw, second);
    pixels(frame(), both);
  }
  raw.lv_lottie_set_draw_buf(first.handle, drawBuffer());
  raw.lv_lottie_set_buffer(second.handle, fixture.source.width, fixture.source.height, buffer());
  premultiplied(raw, first);
  premultiplied(raw, second);
  pixels(frame(), both);
  first.delete();
  expect(raw.lv_anim_count_running()).toBe(running + 1);
  runtime.step(250);
  pixels(frame(), [{ checkpoint: fixture.checkpoints[3]!, x: 44, y: 8 }]);
  second.delete();
  expect(raw.lv_anim_count_running()).toBe(running);
  runtime.step(250);
  pixels(frame(), []);
  close();
});
