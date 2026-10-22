import { expect, test } from "bun:test";
import {
  LV_COLOR_FORMAT_ARGB8888, LV_COLOR_T_SIZE, LV_EVENT_DRAW_MAIN_END,
  LV_IMAGE_DSC_T_FIELDS, LV_IMAGE_DSC_T_SIZE, LV_IMAGE_HEADER_MAGIC,
  LV_IMAGE_HEADER_T_FIELDS, LV_IMAGE_HEADER_T_SIZE, LV_OPA_COVER, LV_PART_MAIN,
  LV_RESULT_INVALID, LV_OBJ_FLAG_SCROLLABLE, LV_SCALE_NONE,
  LV_DRAW_IMAGE_DSC_T_SIZE, LV_DRAW_IMAGE_DSC_T_FIELDS, LV_AREA_T_SIZE, LV_AREA_T_FIELDS,
  LvglRuntime, type Frame,
} from "../bindings/typescript/src/index.ts";
import fixture from "./fixtures/svg/expected.json";
import transforms from "./fixtures/svg/transforms.json";

type Sample = typeof fixture.cases[number];
type Raw = LvglRuntime["unsafe"];
type Placement = { sample: Sample; x: number; y: number };

function transformedPixels(frame: Frame, sample: typeof transforms.cases[number]): void {
  let pixel = 0;
  for (const [length, lower, upper, tolerance] of sample.runs as [number, number[], number[], number][]) {
    for (let repeat = 0; repeat < length; repeat++, pixel++) {
      for (let channel = 0; channel < 4; channel++) {
        const actual = frame.rgba[pixel * 4 + channel]!;
        const margin = channel === 3 ? 0 : tolerance;
        const message = `${sample.name} (${pixel % 80},${Math.floor(pixel / 80)}) channel ${channel}: ${actual} vs ${lower[channel]}..${upper[channel]}`;
        expect(actual, message).toBeGreaterThanOrEqual(lower[channel]! - margin);
        expect(actual, message).toBeLessThanOrEqual(upper[channel]! + margin);
      }
    }
  }
  expect(pixel).toBe(80 * 40);
}

test("SVG image transforms preserve vector coverage, parent clips, layers, and invalidation", async () => {
  const { runtime, raw, display, screen } = await load();
  raw.lv_obj_remove_flag(screen.handle, LV_OBJ_FLAG_SCROLLABLE);
  const bytes = await Bun.file(`tests/fixtures/svg/${transforms.file}`).bytes();
  expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(transforms.sha256);
  runtime.putResource(transforms.file, bytes);
  runtime.step(250);
  for (const sample of transforms.cases) {
    let parent = screen.handle;
    if ("parent" in sample) {
      const [x, y, width, height, opacity] = sample.parent!;
      parent = raw.lv_obj_create(parent);
      raw.lv_obj_remove_style_all(parent);
      raw.lv_obj_remove_flag(parent, LV_OBJ_FLAG_SCROLLABLE);
      raw.lv_obj_set_pos(parent, x!, y!);
      raw.lv_obj_set_size(parent, width!, height!);
      raw.lv_obj_set_style_opa(parent, opacity!, LV_PART_MAIN);
    }
    const image = raw.lv_image_create(parent);
    const path = copy(raw, new TextEncoder().encode(`W:${transforms.file}`));
    raw.lv_image_set_src(image, path); raw.lvw_free(path);
    raw.lv_image_set_pivot(image, sample.pivot[0]!, sample.pivot[1]!);
    raw.lv_image_set_scale_x(image, sample.scale[0]!);
    raw.lv_image_set_scale_y(image, sample.scale[1]!);
    raw.lv_image_set_rotation(image, sample.rotation);
    raw.lv_obj_set_pos(image, sample.position[0]!, sample.position[1]!);
    runtime.step(250);
    transformedPixels(runtime.readFrame(display), sample);
    raw.lv_obj_delete(parent === screen.handle ? image : parent);
    runtime.step(250);
    pixels(runtime.readFrame(display), []);
  }

  const overflowing = new TextDecoder().decode(bytes).replace("</svg>", '<rect x="16" y="0" width="16" height="12" fill="#f00000"/></svg>');
  runtime.putResource("overflow.svg", new TextEncoder().encode(overflowing));
  const bounded = runtime.createImage(screen);
  runtime.setImageSource(bounded, "W:overflow.svg");
  bounded.setPosition(4, 4); runtime.step(250);
  pixels(runtime.readFrame(display), [{ sample: fixture.cases.find(sample => sample.file === transforms.file)!, x: 4, y: 4 }]);
  raw.lv_obj_delete(bounded.handle); runtime.step(250);
  pixels(runtime.readFrame(display), []);

  const descriptor = raw.lvw_alloc(LV_DRAW_IMAGE_DSC_T_SIZE);
  raw.lv_draw_image_dsc_init(descriptor);
  const path = copy(raw, new TextEncoder().encode(`W:${transforms.file}`));
  const area = raw.lvw_alloc(LV_AREA_T_SIZE);
  const view = new DataView(raw.memory.buffer);
  view.setUint32(descriptor + offset(LV_DRAW_IMAGE_DSC_T_FIELDS, "src"), path, true);
  for (const name of ["scale_x", "scale_y"]) view.setUint32(descriptor + offset(LV_DRAW_IMAGE_DSC_T_FIELDS, name), LV_SCALE_NONE * 2, true);
  for (const [name, value] of Object.entries({ x1: 3, y1: 2, x2: 34, y2: 25 })) view.setInt32(area + offset(LV_AREA_T_FIELDS, name), value, true);
  const stop = screen.on(LV_EVENT_DRAW_MAIN_END, () => raw.lv_draw_image(raw.lv_event_get_layer(runtime.eventPointer()), descriptor, area));
  raw.lv_obj_invalidate(screen.handle); runtime.step(250);
  transformedPixels(runtime.readFrame(display), transforms.cases[0]!);
  stop(); raw.lv_obj_invalidate(screen.handle); runtime.step(250);
  pixels(runtime.readFrame(display), []);
  raw.lvw_free(area); raw.lvw_free(path); raw.lvw_free(descriptor);
  runtime.shutdown();
});

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
  return { runtime, raw, display, screen };
}

async function source(sample: Sample): Promise<Uint8Array> {
  const bytes = await Bun.file(`tests/fixtures/svg/${sample.file}`).bytes();
  expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(sample.sha256);
  expect(sample.rgba_min.length).toBe(sample.width * sample.height);
  expect(sample.rgba_max.length).toBe(sample.width * sample.height);
  return bytes;
}

function copy(raw: Raw, bytes: Uint8Array): number {
  const pointer = raw.lvw_alloc(bytes.length + 1);
  new Uint8Array(raw.memory.buffer, pointer, bytes.length + 1).set([...bytes, 0]);
  return pointer;
}

function pixels(frame: Frame, placements: Placement[]): void {
  expect([frame.width, frame.height]).toEqual([80, 40]);
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const placed = placements.find(({ sample, x: left, y: top }) =>
        x >= left && y >= top && x < left + sample.width && y < top + sample.height);
      const index = placed ? (y - placed.y) * placed.sample.width + x - placed.x : 0;
      const lower = placed?.sample.rgba_min[index] ?? [...fixture.background, 255];
      const upper = placed?.sample.rgba_max[index] ?? [...fixture.background, 255];
      const untouched = fixture.background.every((value, channel) => lower[channel] === value && upper[channel] === value);
      const tolerance = untouched ? 0 : placed!.sample.tolerance;
      const start = (y * frame.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const actual = frame.rgba[start + channel]!;
        const message = `${placed?.sample.file ?? "background"} (${x},${y}) channel ${channel}: ${actual} outside ${lower[channel]}..${upper[channel]}`;
        expect(actual, message).toBeGreaterThanOrEqual(lower[channel]! - tolerance);
        expect(actual, message).toBeLessThanOrEqual(upper[channel]! + tolerance);
      }
      expect(frame.rgba[start + 3]).toBe(255);
    }
  }
}

function offset(fields: readonly { name: string | null; bit_offset: number; bit_width: number | null }[], name: string): number {
  const field = fields.find((entry) => entry.name === name)!;
  expect(field.bit_width).toBeNull();
  return field.bit_offset / 8;
}

function variable(raw: Raw, bytes: Uint8Array, sample: Sample): { descriptor: number; data: number; length: number } {
  const data = copy(raw, bytes);
  const descriptor = raw.lvw_alloc(LV_IMAGE_DSC_T_SIZE);
  new Uint8Array(raw.memory.buffer, descriptor, LV_IMAGE_DSC_T_SIZE).fill(0);
  const view = new DataView(raw.memory.buffer);
  const header = descriptor + offset(LV_IMAGE_DSC_T_FIELDS, "header");
  const values: Record<string, number> = {
    magic: LV_IMAGE_HEADER_MAGIC, cf: LV_COLOR_FORMAT_ARGB8888,
    w: sample.width, h: sample.height, stride: sample.width * 4,
  };
  for (const field of LV_IMAGE_HEADER_T_FIELDS) {
    const value = values[field.name];
    if (value === undefined) continue;
    if (field.bit_width === 8) view.setUint8(header + field.bit_offset / 8, value);
    else {
      expect(field.bit_width).toBe(16);
      view.setUint16(header + field.bit_offset / 8, value, true);
    }
  }
  view.setUint32(descriptor + offset(LV_IMAGE_DSC_T_FIELDS, "data_size"), bytes.length, true);
  view.setUint32(descriptor + offset(LV_IMAGE_DSC_T_FIELDS, "data"), data, true);
  return { descriptor, data, length: bytes.length };
}

test("SVG geometry, fill rules, gradients and curves retain draw tasks after document deletion", async () => {
  const { runtime, raw, display, screen } = await load();
  for (const sample of fixture.cases) {
    const bytes = await source(sample);
    let draws = 0;
    const stop = screen.on(LV_EVENT_DRAW_MAIN_END, () => {
      const pointer = copy(raw, bytes);
      const document = raw.lv_svg_load_data(pointer, bytes.length);
      expect(document).not.toBe(0);
      new Uint8Array(raw.memory.buffer, pointer, bytes.length + 1).fill(0x78);
      raw.lvw_free(pointer);
      raw.lv_draw_svg(raw.lv_event_get_layer(runtime.eventPointer()), document);
      raw.lv_svg_node_delete(document);
      draws++;
    });
    for (let redraw = 0; redraw < 2; redraw++) {
      raw.lv_obj_invalidate(screen.handle);
      raw.lv_refr_now(display.handle);
      expect(draws).toBe(redraw + 1);
      pixels(runtime.readFrame(display), [{ sample, x: 0, y: 0 }]);
    }
    stop();
    raw.lv_obj_invalidate(screen.handle);
    raw.lv_refr_now(display.handle);
    pixels(runtime.readFrame(display), []);
  }
  runtime.shutdown();
});

test("SVG file resources are copied and reusable while variable descriptors retain their borrowed XML", async () => {
  const { runtime, raw, display, screen } = await load();
  const geometry = fixture.cases.find((sample) => sample.file === "geometry.svg")!;
  const fills = fixture.cases.find((sample) => sample.file === "fills.svg")!;
  const gradient = fixture.cases.find((sample) => sample.file === "gradient.svg")!;
  const uploaded = await source(geometry);
  runtime.putResource("shared.svg", uploaded);
  uploaded.fill(0);
  runtime.putResource(fills.file, await source(fills));
  const first = runtime.createImage(screen);
  const second = runtime.createImage(screen);
  first.setPosition(4, 4);
  second.setPosition(44, 8);
  runtime.setImageSource(first, "W:shared.svg");
  runtime.setImageSource(second, "W:shared.svg");
  expect([raw.lv_image_get_src_width(first.handle), raw.lv_image_get_src_height(first.handle)])
    .toEqual([geometry.width, geometry.height]);
  for (let redraw = 0; redraw < 2; redraw++) {
    raw.lv_obj_invalidate(screen.handle);
    raw.lv_refr_now(display.handle);
    pixels(runtime.readFrame(display), [{ sample: geometry, x: 4, y: 4 }, { sample: geometry, x: 44, y: 8 }]);
  }
  first.delete();
  raw.lv_refr_now(display.handle);
  pixels(runtime.readFrame(display), [{ sample: geometry, x: 44, y: 8 }]);
  const replacement = runtime.createImage(screen);
  replacement.setPosition(4, 4);
  runtime.setImageSource(replacement, `W:${fills.file}`);
  const borrowed = variable(raw, await source(gradient), gradient);
  raw.lv_image_set_src(second.handle, borrowed.descriptor);
  expect([raw.lv_image_get_src_width(second.handle), raw.lv_image_get_src_height(second.handle)])
    .toEqual([gradient.width, gradient.height]);
  for (let redraw = 0; redraw < 2; redraw++) {
    raw.lv_obj_invalidate(screen.handle);
    raw.lv_refr_now(display.handle);
    pixels(runtime.readFrame(display), [{ sample: fills, x: 4, y: 4 }, { sample: gradient, x: 44, y: 8 }]);
  }
  second.delete();
  new Uint8Array(raw.memory.buffer, borrowed.data, borrowed.length + 1).fill(0);
  raw.lvw_free(borrowed.descriptor);
  raw.lvw_free(borrowed.data);
  raw.lv_refr_now(display.handle);
  pixels(runtime.readFrame(display), [{ sample: fills, x: 4, y: 4 }]);
  runtime.setImageSource(replacement, "W:shared.svg");
  raw.lv_refr_now(display.handle);
  pixels(runtime.readFrame(display), [{ sample: geometry, x: 4, y: 4 }]);
  replacement.delete();
  raw.lv_refr_now(display.handle);
  pixels(runtime.readFrame(display), []);
  runtime.shutdown();
});

test("SVG parsing rejects incomplete documents and recovers with dimensions independent of attribute order and header length", async () => {
  const { runtime, raw, display, screen } = await load();
  const image = runtime.createImage(screen);
  image.setPosition(4, 4);
  for (const sample of fixture.cases) {
    runtime.putResource(sample.file, await source(sample));
    runtime.setImageSource(image, `W:${sample.file}`);
    expect([raw.lv_image_get_src_width(image.handle), raw.lv_image_get_src_height(image.handle)], sample.file)
      .toEqual([sample.width, sample.height]);
    raw.lv_refr_now(display.handle);
    pixels(runtime.readFrame(display), [{ sample, x: 4, y: 4 }]);
  }
  const valid = fixture.cases.find((sample) => sample.file === "geometry.svg")!;
  const header = raw.lvw_alloc(LV_IMAGE_HEADER_T_SIZE);
  for (const rejected of fixture.rejected) {
    const bytes = await Bun.file(`tests/fixtures/svg/${rejected.file}`).bytes();
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(rejected.sha256);
    const xml = copy(raw, bytes);
    expect(raw.lv_svg_load_data(xml, bytes.length), rejected.file).toBe(0);
    raw.lvw_free(xml);
    runtime.putResource(rejected.file, bytes);
    const path = copy(raw, new TextEncoder().encode(`W:${rejected.file}`));
    new Uint8Array(raw.memory.buffer, header, LV_IMAGE_HEADER_T_SIZE).fill(0);
    expect(raw.lv_image_decoder_get_info(path, header), rejected.file).toBe(LV_RESULT_INVALID);
    raw.lvw_free(path);
    runtime.setImageSource(image, `W:${rejected.file}`);
    expect(raw.lv_image_get_src(image.handle), rejected.file).toBe(0);
    raw.lv_refr_now(display.handle);
    pixels(runtime.readFrame(display), []);
    runtime.setImageSource(image, `W:${valid.file}`);
    raw.lv_refr_now(display.handle);
    pixels(runtime.readFrame(display), [{ sample: valid, x: 4, y: 4 }]);
  }
  raw.lvw_free(header);
  runtime.shutdown();
});
