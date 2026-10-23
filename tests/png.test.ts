import { expect, test } from "bun:test";
import type { Frame } from "../bindings/typescript/src/index.ts";
import fixture from "./fixtures/png/expected.json";
import headers from "./fixtures/png/headers.json";

const sdk = await import(Bun.env.LVW_TEST_TS_RUNTIME ?? "../bindings/typescript/src/index.ts") as
  typeof import("../bindings/typescript/src/index.ts");
const { LV_COLOR_T_SIZE, LV_OPA_COVER, LV_PART_MAIN, LvglRuntime } = sdk;
const legacy = Number(sdk.LVGL_VERSION_MINOR) === 0;

function offset(fields: readonly { name: string | null; bit_offset: number }[], name: string): number {
  const field = fields.find((field) => field.name === name)!;
  expect(field.bit_offset % 8).toBe(0);
  return field.bit_offset / 8;
}

async function load() {
  const runtime = await LvglRuntime.load(await Bun.file(Bun.env.LVW_TEST_CORE ?? "target/wasm/liblvgl.wasm").arrayBuffer());
  const display = runtime.createDisplay(48, 32);
  const screen = runtime.screen(display);
  const raw = runtime.unsafe;
  const color = raw.lvw_alloc(LV_COLOR_T_SIZE);
  const [red, green, blue] = fixture.background;
  raw.lv_color_hex(color, (red! << 16) | (green! << 8) | blue!);
  raw.lv_obj_set_style_bg_color(screen.handle, color, LV_PART_MAIN);
  raw.lv_obj_set_style_bg_opa(screen.handle, LV_OPA_COVER, LV_PART_MAIN);
  raw.lvw_free(color);
  return { runtime, display, screen, raw };
}

function pixel(frame: Frame, x: number, y: number): number[] {
  const offset = (y * frame.width + x) * 4;
  return [...frame.rgba.subarray(offset, offset + 4)];
}

function imagePixels(frame: Frame, x: number, y: number, alpha: boolean): void {
  expect(fixture.rgba.length).toBe(fixture.width * fixture.height);
  for (let row = 0; row < fixture.height; row++) {
    for (let column = 0; column < fixture.width; column++) {
      const source = fixture.rgba[row * fixture.width + column]!;
      const opacity = alpha ? source[3]! : 255;
      const actual = pixel(frame, x + column, y + row);
      for (let channel = 0; channel < 3; channel++) {
        // The reference truncates to 8-bit once; native premultiplication and blending may truncate separately.
        const expected = Math.floor((source[channel]! * opacity + fixture.background[channel]! * (255 - opacity)) / 255);
        if (opacity === 0 || opacity === 255) expect(actual[channel]).toBe(expected);
        else expect(Math.abs(actual[channel]! - expected),
          `PNG pixel (${column}, ${row}), channel ${channel}: ${actual[channel]} vs ${expected}, source ${source}`)
          .toBeLessThanOrEqual(1);
      }
      expect(actual[3]).toBe(255);
    }
  }
  for (let column = -1; column <= fixture.width; column++) {
    expect(pixel(frame, x + column, y - 1)).toEqual([...fixture.background, 255]);
    expect(pixel(frame, x + column, y + fixture.height)).toEqual([...fixture.background, 255]);
  }
  for (let row = 0; row < fixture.height; row++) {
    expect(pixel(frame, x - 1, y + row)).toEqual([...fixture.background, 255]);
    expect(pixel(frame, x + fixture.width, y + row)).toEqual([...fixture.background, 255]);
  }
}

function backgroundPixels(frame: Frame, x: number, y: number): void {
  for (let row = 0; row < fixture.height; row++) {
    for (let column = 0; column < fixture.width; column++) {
      expect(pixel(frame, x + column, y + row)).toEqual([...fixture.background, 255]);
    }
  }
}

test("RGB, RGBA, indexed transparency and Adam7 PNGs render fixed pixels across redraws and source changes", async () => {
  const { runtime, display, screen, raw } = await load();
  const image = runtime.createImage(screen);
  image.setPosition(6, 5);
  let previousFrame = 0;
  for (const sample of fixture.cases) {
    const bytes = await Bun.file(`tests/fixtures/png/${sample.file}`).bytes();
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(sample.sha256);
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect([header.getUint32(16), header.getUint32(20)]).toEqual([fixture.width, fixture.height]);
    expect([bytes[24], bytes[25], bytes[28]]).toEqual([sample.bit_depth, sample.color_type, sample.interlace]);
    runtime.putResource(sample.file, bytes);
    runtime.setImageSource(image, `W:${sample.file}`);
    raw.lv_obj_update_layout(image.handle);
    expect(raw.lv_obj_get_width(image.handle)).toBe(fixture.width);
    expect(raw.lv_obj_get_height(image.handle)).toBe(fixture.height);
    for (let redraw = 0; redraw < 2; redraw++) {
      raw.lv_obj_invalidate(image.handle);
      runtime.step(33);
      const frame = runtime.readFrame(display);
      expect(frame.frameId).toBeGreaterThan(previousFrame);
      previousFrame = frame.frameId;
      imagePixels(frame, 6, 5, sample.alpha);
    }
  }
  runtime.shutdown();
});

test("PNG failures preserve native source selection and valid images recover in the same runtime", async () => {
  const { runtime, display, screen, raw } = await load();
  const image = runtime.createImage(screen);
  image.setPosition(6, 5);
  const valid = fixture.cases.find((sample) => sample.file === "rgba.png")!;
  runtime.putResource(valid.file, await Bun.file(`tests/fixtures/png/${valid.file}`).bytes());
  for (const name of fixture.rejected) {
    const bytes = await Bun.file(`tests/fixtures/png/${name}`).bytes();
    if (name === fixture.unsupported.file) {
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(fixture.unsupported.sha256);
      expect([bytes[24], bytes[25]]).toEqual([fixture.unsupported.bit_depth, fixture.unsupported.color_type]);
    }
    runtime.putResource(name, bytes);
    const previous = raw.lv_image_get_src(image.handle);
    runtime.setImageSource(image, `W:${name}`);
    raw.lv_obj_update_layout(image.handle);
    const rejectedHeader = legacy && name === fixture.unsupported.file;
    if (rejectedHeader) expect(raw.lv_image_get_src(image.handle)).toBe(previous);
    else {
      expect(raw.lv_obj_get_width(image.handle)).toBe(fixture.width);
      expect(raw.lv_obj_get_height(image.handle)).toBe(fixture.height);
    }
    runtime.step(33);
    if (rejectedHeader) imagePixels(runtime.readFrame(display), 6, 5, valid.alpha);
    else backgroundPixels(runtime.readFrame(display), 6, 5);
    runtime.setImageSource(image, `W:${valid.file}`);
    runtime.step(33);
    imagePixels(runtime.readFrame(display), 6, 5, valid.alpha);
  }
  runtime.putResource("short.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  const previous = raw.lv_image_get_src(image.handle);
  runtime.setImageSource(image, "W:short.png");
  expect(raw.lv_image_get_src(image.handle)).toBe(legacy ? previous : 0);
  runtime.step(33);
  if (legacy) imagePixels(runtime.readFrame(display), 6, 5, valid.alpha);
  else backgroundPixels(runtime.readFrame(display), 6, 5);
  runtime.setImageSource(image, `W:${valid.file}`);
  runtime.step(33);
  imagePixels(runtime.readFrame(display), 6, 5, valid.alpha);
  runtime.shutdown();
});

test("uploaded PNG bytes are copied and remain reusable after individual image deletion", async () => {
  const { runtime, display, screen, raw } = await load();
  const bytes = await Bun.file("tests/fixtures/png/indexed.png").bytes();
  runtime.putResource("shared.png", bytes);
  bytes.fill(0);
  const first = runtime.createImage(screen);
  const second = runtime.createImage(screen);
  first.setPosition(6, 5);
  second.setPosition(26, 15);
  runtime.setImageSource(first, "W:shared.png");
  runtime.setImageSource(second, "W:shared.png");
  runtime.step(33);
  imagePixels(runtime.readFrame(display), 6, 5, true);
  imagePixels(runtime.readFrame(display), 26, 15, true);
  first.delete();
  raw.lv_obj_invalidate(second.handle);
  runtime.step(33);
  const remaining = runtime.readFrame(display);
  backgroundPixels(remaining, 6, 5);
  imagePixels(remaining, 26, 15, true);
  second.delete();
  const replacement = runtime.createImage(screen);
  replacement.setPosition(6, 5);
  runtime.setImageSource(replacement, "W:shared.png");
  runtime.step(33);
  const reused = runtime.readFrame(display);
  imagePixels(reused, 6, 5, true);
  backgroundPixels(reused, 26, 15);
  runtime.shutdown();
});

test.skipIf(!legacy)("legacy PNG headers enforce byte and dimension bounds for files and borrowed descriptors", async () => {
  const { runtime, display, screen, raw } = await load();
  const descriptor = raw.lvw_alloc(sdk.LV_IMAGE_DSC_T_SIZE);
  const output = raw.lvw_alloc(sdk.LV_IMAGE_HEADER_T_SIZE);
  const dataOffset = offset(sdk.LV_IMAGE_DSC_T_FIELDS, "data");
  const sizeOffset = offset(sdk.LV_IMAGE_DSC_T_FIELDS, "data_size");
  const headerOffset = offset(sdk.LV_IMAGE_DSC_T_FIELDS, "header");
  const widthOffset = offset(sdk.LV_IMAGE_HEADER_T_FIELDS, "w");
  const heightOffset = offset(sdk.LV_IMAGE_HEADER_T_FIELDS, "h");
  new Uint8Array(raw.memory.buffer, descriptor, sdk.LV_IMAGE_DSC_T_SIZE).fill(0);
  let view = new DataView(raw.memory.buffer);
  view.setUint8(descriptor + headerOffset + offset(sdk.LV_IMAGE_HEADER_T_FIELDS, "magic"), sdk.LV_IMAGE_HEADER_MAGIC);
  view.setUint8(descriptor + headerOffset + offset(sdk.LV_IMAGE_HEADER_T_FIELDS, "cf"), sdk.LV_COLOR_FORMAT_RAW_ALPHA);
  view.setUint16(descriptor + headerOffset + widthOffset, 999, true);
  view.setUint16(descriptor + headerOffset + heightOffset, 999, true);
  // Put truncated inputs at the memory boundary so an unchecked header read traps.
  raw.memory.grow(1);
  for (const sample of headers) {
    const bytes = Uint8Array.fromHex(sample.hex);
    const pointer = raw.memory.buffer.byteLength - bytes.length;
    new Uint8Array(raw.memory.buffer, pointer, bytes.length).set(bytes);
    view = new DataView(raw.memory.buffer);
    view.setUint32(descriptor + dataOffset, pointer, true);
    view.setUint32(descriptor + sizeOffset, bytes.length, true);
    const stride = Math.ceil(sample.width * 4 / sdk.LV_DRAW_BUF_STRIDE_ALIGN) * sdk.LV_DRAW_BUF_STRIDE_ALIGN;
    const valid = sample.valid && stride <= 65535;
    const expected = valid ? sdk.LV_RESULT_OK : sdk.LV_RESULT_INVALID;
    expect(raw.lv_image_decoder_get_info(descriptor, output), sample.name).toBe(expected);
    if (valid) {
      view = new DataView(raw.memory.buffer);
      expect([view.getUint16(output + widthOffset, true), view.getUint16(output + heightOffset, true)])
        .toEqual([sample.width, sample.height]);
    }
    raw.lv_image_cache_drop(descriptor);
    const path = new TextEncoder().encode(`W:header-${sample.name}.png\0`);
    const source = raw.lvw_alloc(path.length);
    runtime.putResource(`header-${sample.name}.png`, bytes);
    new Uint8Array(raw.memory.buffer, source, path.length).set(path);
    expect(raw.lv_image_decoder_get_info(source, output), sample.name).toBe(expected);
    raw.lvw_free(source);
  }
  const bytes = await Bun.file("tests/fixtures/png/rgba.png").bytes();
  const source = raw.lvw_alloc(bytes.length);
  new Uint8Array(raw.memory.buffer, source, bytes.length).set(bytes);
  view = new DataView(raw.memory.buffer);
  view.setUint32(descriptor + dataOffset, source, true);
  view.setUint32(descriptor + sizeOffset, bytes.length, true);
  const image = runtime.createImage(screen);
  image.setPosition(6, 5);
  raw.lv_image_set_src(image.handle, descriptor);
  runtime.step(33);
  imagePixels(runtime.readFrame(display), 6, 5, true);
  image.delete();
  raw.lv_image_cache_drop(descriptor);
  for (const pointer of [source, descriptor, output]) raw.lvw_free(pointer);
  runtime.shutdown();
});
