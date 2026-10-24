import { expect, test } from "bun:test";
import type { Frame, UnsafeLvgl } from "../bindings/typescript/src/index.ts";
const sdk: typeof import("../bindings/typescript/src/index.ts") = await import(
  Bun.env.LVW_TEST_TS_RUNTIME ?? "../bindings/typescript/src/index.ts");
const {
  LV_COLOR_T_SIZE, LV_DRAW_BUF_T_FIELDS, LV_FONT_GLYPH_DSC_T_FIELDS, LV_FONT_GLYPH_DSC_T_SIZE,
  LV_FONT_GLYPH_FORMAT_A8, LV_FONT_KERNING_NONE, LV_FONT_KERNING_NORMAL, LV_FONT_T_FIELDS,
  LV_IMAGE_HEADER_T_FIELDS, LV_OPA_COVER, LV_PART_MAIN, LV_STYLE_TEXT_FONT,
  LV_TEXT_LEADING_TRIM_NONE, LvglRuntime,
} = sdk;
import fixture from "./fixtures/tinyttf/expected.json";
const minor = Number(sdk.LVGL_VERSION_MINOR);
const legacy = [0, 1].includes(minor);

interface LegacyFontApi {
  lv_tiny_ttf_create_data_ex(data: number, length: number, size: number, cache: number): number;
  lv_font_get_glyph_bitmap(descriptor: number, letter: number, buffer: number): number;
  lv_cache_entry_get_cache(entry: number): number;
  lv_cache_entry_get_ref(entry: number): number;
  lv_cache_get_size(cache: number, data: number): number;
  lv_cache_get_max_size(cache: number, data: number): number;
  lv_cache_release(cache: number, entry: number, data: number): void;
}

function createFont(raw: UnsafeLvgl, data: { pointer: number; length: number }, size: number, cache?: number): number {
  if (cache === undefined) return raw.lv_tiny_ttf_create_data(data.pointer, data.length, size);
  if (legacy) return (raw as unknown as LegacyFontApi).lv_tiny_ttf_create_data_ex(data.pointer, data.length, size, cache);
  return raw.lv_tiny_ttf_create_data_ex(data.pointer, data.length, size, LV_FONT_KERNING_NORMAL, cache);
}

function releaseGlyph(raw: UnsafeLvgl, descriptor: number): void {
  if (!legacy) { raw.lv_font_glyph_release_draw_data(descriptor); return; }
  const view = new DataView(raw.memory.buffer);
  const address = descriptor + offset(LV_FONT_GLYPH_DSC_T_FIELDS, "entry");
  const entry = view.getUint32(address, true);
  if (entry) {
    const api = raw as unknown as LegacyFontApi;
    api.lv_cache_release(api.lv_cache_entry_get_cache(entry), entry, 0);
    new DataView(raw.memory.buffer).setUint32(address, 0, true);
  }
}

type Size = typeof fixture.sizes[number];
type Glyph = keyof Size["glyphs"];
type Fields = readonly { name: string | null; bit_offset: number; bit_width: number | null }[];

function offset(fields: Fields, name: string): number {
  const field = fields.find((item) => item.name === name)!;
  expect(field.bit_offset % 8).toBe(0);
  return field.bit_offset / 8;
}

async function load() {
  const runtime = await LvglRuntime.load(await Bun.file(Bun.env.LVW_TEST_CORE ?? "target/wasm/liblvgl.wasm").arrayBuffer());
  const raw = runtime.unsafe;
  const display = runtime.createDisplay(240, 128);
  const screen = runtime.screen(display);
  const color = raw.lvw_alloc(LV_COLOR_T_SIZE);
  const rgb = (channels: number[]) => (channels[0]! << 16) | (channels[1]! << 8) | channels[2]!;
  raw.lv_color_hex(color, rgb(fixture.background));
  raw.lv_obj_set_style_bg_color(screen.handle, color, LV_PART_MAIN);
  raw.lv_obj_set_style_bg_opa(screen.handle, LV_OPA_COVER, LV_PART_MAIN);
  raw.lv_color_hex(color, rgb(fixture.foreground));
  raw.lv_obj_set_style_text_color(screen.handle, color, LV_PART_MAIN);
  raw.lv_obj_set_style_text_opa(screen.handle, LV_OPA_COVER, LV_PART_MAIN);
  raw.lvw_free(color);
  function label(font: number, names: Glyph[], x: number, y: number) {
    const object = runtime.createLabel(screen);
    raw.lv_obj_set_style_text_font(object.handle, font, LV_PART_MAIN);
    raw.lv_obj_set_style_text_letter_space(object.handle, 0, LV_PART_MAIN);
    raw.lv_obj_set_style_text_line_space(object.handle, 0, LV_PART_MAIN);
    if (!legacy) raw.lv_obj_set_style_text_leading_trim(object.handle, LV_TEXT_LEADING_TRIM_NONE, LV_PART_MAIN);
    runtime.setText(object, names.map((name) => String.fromCodePoint(fixture.codepoints[name])).join(""));
    object.setPosition(x, y);
    return object;
  }
  function frame(): Frame {
    raw.lv_obj_update_layout(screen.handle);
    raw.lv_refr_now(display.handle);
    return runtime.readFrame(display);
  }
  return { runtime, raw, display, label, frame };
}

async function fontData(raw: UnsafeLvgl, sample = fixture.font) {
  const bytes = await Bun.file(`${Bun.env.LVW_TEST_TINYTTF_FIXTURES ?? "tests/fixtures/tinyttf"}/${sample.file}`).bytes();
  expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(sample.sha256);
  const pointer = raw.lvw_alloc(bytes.length);
  new Uint8Array(raw.memory.buffer, pointer, bytes.length).set(bytes);
  return { pointer, length: bytes.length };
}

function glyph(raw: UnsafeLvgl, font: number, name: Glyph, size: Size, resolvedFont = font): void {
  const expected = size.glyphs[name];
  const descriptor = raw.lvw_alloc(LV_FONT_GLYPH_DSC_T_SIZE);
  try {
    expect(raw.lv_font_get_glyph_dsc(font, descriptor, fixture.codepoints[name], 0)).toBe(1);
    let view = new DataView(raw.memory.buffer);
    expect(view.getUint32(descriptor + offset(LV_FONT_GLYPH_DSC_T_FIELDS, "resolved_font"), true)).toBe(resolvedFont);
    if (minor === 0) {
      const bit = LV_FONT_GLYPH_DSC_T_FIELDS.find((field) => field.name === "bpp")!;
      expect((view.getUint8(descriptor + Math.floor(bit.bit_offset / 8)) >> (bit.bit_offset % 8)) & 15).toBe(8);
    } else {
      const address = descriptor + offset(LV_FONT_GLYPH_DSC_T_FIELDS, "format");
      expect(sdk.LV_FONT_GLYPH_FORMAT_T_SIZE).toBe(minor === 1 ? 1 : 4);
      expect(minor === 1 ? view.getUint8(address) : view.getUint32(address, true)).toBe(LV_FONT_GLYPH_FORMAT_A8);
    }
    for (const [field, value] of [["adv_w", expected.advance], ["box_w", expected.box_w], ["box_h", expected.box_h]] as const) {
      expect(view.getUint16(descriptor + offset(LV_FONT_GLYPH_DSC_T_FIELDS, field), true)).toBe(value);
    }
    for (const field of ["ofs_x", "ofs_y"] as const) {
      expect(view.getInt16(descriptor + offset(LV_FONT_GLYPH_DSC_T_FIELDS, field), true)).toBe(expected[field]);
    }
    const buffer = legacy ? (raw as unknown as LegacyFontApi).lv_font_get_glyph_bitmap(descriptor, fixture.codepoints[name], 0)
      : raw.lv_font_get_glyph_bitmap(descriptor, 0);
    expect(buffer).not.toBe(0);
    view = new DataView(raw.memory.buffer);
    const data = view.getUint32(buffer + offset(LV_DRAW_BUF_T_FIELDS, "data"), true);
    const stride = view.getUint16(buffer + offset(LV_DRAW_BUF_T_FIELDS, "header")
      + offset(LV_IMAGE_HEADER_T_FIELDS, "stride"), true);
    expect(stride).toBeGreaterThanOrEqual(expected.box_w);
    for (let y = 0; y < expected.box_h; y++) {
      for (let x = 0; x < expected.box_w; x++) {
        const alpha = expected.alpha[y]![x]!;
        const actual = view.getUint8(data + y * stride + x);
        if (alpha === 0 || alpha === 255) expect(actual).toBe(alpha);
        else expect(Math.abs(actual - alpha), `${name} at ${size.size}px, A8 (${x}, ${y}): ${actual} vs ${alpha}`)
          .toBeLessThanOrEqual(1);
      }
    }
  } finally {
    // Release the borrowed draw data before resizing or destroying its font cache.
    releaseGlyph(raw, descriptor);
    raw.lvw_free(descriptor);
  }
}

function textWidth(size: Size, names: Glyph[]): number {
  return names.reduce((width, name, index) => width + size.glyphs[name].advance
    - (name === "A" && names[index + 1] === "B" ? size.kerning : 0), 0);
}

function textPixels(frame: Frame, size: Size, names: Glyph[], x: number, y: number): void {
  const width = textWidth(size, names);
  const mask = Array.from({ length: size.line_height }, () => new Uint8Array(width));
  let pen = 0;
  for (let index = 0; index < names.length; index++) {
    const name = names[index]!;
    const expected = size.glyphs[name];
    const top = size.line_height - size.baseline - expected.box_h - expected.ofs_y;
    for (let row = 0; row < expected.box_h; row++) {
      for (let column = 0; column < expected.box_w; column++) {
        mask[top + row]![pen + expected.ofs_x + column] = expected.alpha[row]![column]!;
      }
    }
    pen += expected.advance - (name === "A" && names[index + 1] === "B" ? size.kerning : 0);
  }
  for (let row = -1; row <= size.line_height; row++) {
    for (let column = -1; column <= width; column++) {
      const alpha = mask[row]?.[column] ?? 0;
      const pixel = ((y + row) * frame.width + x + column) * 4;
      for (let channel = 0; channel < 3; channel++) {
        // Independent source-over truncates once; raster quantization and native blending can each truncate.
        const expected = Math.floor((fixture.foreground[channel]! * alpha + fixture.background[channel]! * (255 - alpha)) / 255);
        const actual = frame.rgba[pixel + channel]!;
        if (alpha === 0 || alpha === 255) expect(actual).toBe(expected);
        else expect(Math.abs(actual - expected), `text ${names} at ${size.size}px (${column}, ${row}): ${actual} vs ${expected}`)
          .toBeLessThanOrEqual(2);
      }
      expect(frame.rgba[pixel + 3]).toBe(255);
    }
  }
}

test("TinyTTF metrics, composite glyph coverage and kerning preserve the selected cache semantics", async () => {
  const { runtime, raw } = await load();
  const data = await fontData(raw);
  const size = fixture.sizes[1]!;
  for (const cache of [0, 1, undefined]) {
    const font = createFont(raw, data, size.size, cache);
    expect(font).not.toBe(0);
    expect(raw.lv_font_get_line_height(font)).toBe(size.line_height);
    expect(new DataView(raw.memory.buffer).getInt32(font + offset(LV_FONT_T_FIELDS, "base_line"), true)).toBe(size.baseline);
    for (const name of ["A", "B", "Aacute", "space", "A"] as const) glyph(raw, font, name, size);
    expect(raw.lv_font_get_glyph_width(font, fixture.codepoints.A, fixture.codepoints.B)).toBe(size.glyphs.A.advance - size.kerning);
    raw.lv_font_set_kerning(font, LV_FONT_KERNING_NONE);
    expect(raw.lv_font_get_glyph_width(font, fixture.codepoints.A, fixture.codepoints.B)).toBe(size.glyphs.A.advance);
    raw.lv_font_set_kerning(font, LV_FONT_KERNING_NORMAL);
    expect(raw.lv_font_get_glyph_width(font, fixture.codepoints.A, fixture.codepoints.B)).toBe(size.glyphs.A.advance - size.kerning);
    const missing = raw.lvw_alloc(LV_FONT_GLYPH_DSC_T_SIZE);
    expect(raw.lv_font_get_glyph_dsc(font, missing, fixture.codepoints.Omega, 0)).toBe(0);
    const view = new DataView(raw.memory.buffer);
    expect(view.getUint32(missing + offset(LV_FONT_GLYPH_DSC_T_FIELDS, "resolved_font"), true)).toBe(0);
    const bit = LV_FONT_GLYPH_DSC_T_FIELDS.find((field) => field.name === "is_placeholder")!;
    expect((view.getUint8(missing + Math.floor(bit.bit_offset / 8)) >> (bit.bit_offset % 8)) & 1).toBe(1);
    raw.lvw_free(missing);
    raw.lv_tiny_ttf_destroy(font);
  }
  raw.lvw_free(data.pointer);
  runtime.shutdown();
});

test("shared fonts and fallback glyphs render fixed geometry after every explicit size refresh", async () => {
  const { runtime, raw, label, frame } = await load();
  const data = await fontData(raw);
  const fallbackData = await fontData(raw, fixture.fallback);
  const font = raw.lv_tiny_ttf_create_data(data.pointer, data.length, fixture.sizes[0]!.size);
  const fallback = raw.lv_tiny_ttf_create_data(fallbackData.pointer, fallbackData.length, fixture.sizes[0]!.size);
  expect(font).not.toBe(0);
  expect(fallback).not.toBe(0);
  new DataView(raw.memory.buffer).setUint32(font + offset(LV_FONT_T_FIELDS, "fallback"), fallback, true);
  const firstText: Glyph[] = ["A", "B", "space", "Aacute", "space", "Omega"];
  const secondText: Glyph[] = ["B", "A"];
  const first = label(font, firstText, 8, 8);
  const second = label(font, secondText, 8, 72);
  for (const size of [...fixture.sizes, fixture.sizes[0]!]) {
    raw.lv_tiny_ttf_set_size(font, size.size);
    raw.lv_tiny_ttf_set_size(fallback, size.size);
    for (const object of [first, second]) raw.lv_obj_refresh_style(object.handle, LV_PART_MAIN, LV_STYLE_TEXT_FONT);
    glyph(raw, font, "Aacute", size);
    glyph(raw, font, "Omega", size, fallback);
    const rendered = frame();
    expect(raw.lv_obj_get_width(first.handle)).toBe(textWidth(size, firstText));
    expect(raw.lv_obj_get_width(second.handle)).toBe(textWidth(size, secondText));
    expect(raw.lv_obj_get_height(first.handle)).toBe(size.line_height);
    textPixels(rendered, size, firstText, 8, 8);
    textPixels(rendered, size, secondText, 8, 72);
  }
  first.delete();
  runtime.setText(second, "ÁΩ");
  textPixels(frame(), fixture.sizes[0]!, ["Aacute", "Omega"], 8, 72);
  second.delete();
  raw.lv_tiny_ttf_destroy(font);
  raw.lv_tiny_ttf_destroy(fallback);
  raw.lvw_free(data.pointer);
  raw.lvw_free(fallbackData.pointer);
  runtime.shutdown();
});

test("font objects independently borrow the same bytes until their last user and font are destroyed", async () => {
  const { runtime, raw, display, label, frame } = await load();
  const data = await fontData(raw);
  const small = fixture.sizes[0]!;
  const large = fixture.sizes[2]!;
  const firstFont = createFont(raw, data, small.size, 1);
  const secondFont = createFont(raw, data, large.size, 0);
  expect(firstFont).not.toBe(0);
  expect(secondFont).not.toBe(0);
  const first = label(firstFont, ["A"], 8, 8);
  const second = label(secondFont, ["B"], 8, 72);
  const before = frame();
  textPixels(before, small, ["A"], 8, 8);
  textPixels(before, large, ["B"], 8, 72);
  first.delete();
  raw.lv_tiny_ttf_destroy(firstFont);
  const resized = fixture.sizes[1]!;
  raw.lv_tiny_ttf_set_size(secondFont, resized.size);
  raw.lv_obj_refresh_style(second.handle, LV_PART_MAIN, LV_STYLE_TEXT_FONT);
  runtime.setText(second, "Á");
  glyph(raw, secondFont, "Aacute", resized);
  textPixels(frame(), resized, ["Aacute"], 8, 72);
  second.delete();
  raw.lv_tiny_ttf_destroy(secondFont);
  raw.lvw_free(data.pointer);
  expect(raw.lv_font_get_line_height(raw.lv_obj_get_style_text_font(runtime.screen(display).handle, LV_PART_MAIN))).toBeGreaterThan(0);
  runtime.step(33);
  runtime.shutdown();
});

test.skipIf(!legacy)("legacy TinyTTF resize and destruction preserve another font's borrowed cache entry", async () => {
  const { runtime, raw } = await load();
  const api = raw as unknown as LegacyFontApi;
  const data = await fontData(raw);
  const first = createFont(raw, data, fixture.sizes[0]!.size, 0);
  const second = createFont(raw, data, fixture.sizes[1]!.size, 1);
  glyph(raw, first, "A", fixture.sizes[0]!);
  const descriptor = raw.lvw_alloc(LV_FONT_GLYPH_DSC_T_SIZE);
  expect(raw.lv_font_get_glyph_dsc(second, descriptor, fixture.codepoints.B, 0)).toBe(1);
  expect(api.lv_font_get_glyph_bitmap(descriptor, fixture.codepoints.B, 0)).not.toBe(0);
  const entry = new DataView(raw.memory.buffer).getUint32(descriptor + offset(LV_FONT_GLYPH_DSC_T_FIELDS, "entry"), true);
  const cache = api.lv_cache_entry_get_cache(entry);
  expect(api.lv_cache_get_max_size(cache, 0)).toBe(128);
  expect(api.lv_cache_get_size(cache, 0)).toBe(2);
  raw.lv_tiny_ttf_set_size(first, fixture.sizes[2]!.size);
  expect(api.lv_cache_get_size(cache, 0)).toBe(1);
  glyph(raw, first, "A", fixture.sizes[2]!);
  raw.lv_tiny_ttf_destroy(first);
  expect(api.lv_cache_get_size(cache, 0)).toBe(1);
  releaseGlyph(raw, descriptor);
  glyph(raw, second, "B", fixture.sizes[1]!);
  raw.lv_tiny_ttf_destroy(second);
  expect(api.lv_cache_get_size(cache, 0)).toBe(0);
  const fonts = Array.from({ length: 132 }, () => createFont(raw, data, 16));
  for (const font of fonts) {
    expect(raw.lv_font_get_glyph_dsc(font, descriptor, fixture.codepoints.A, 0)).toBe(1);
    expect(api.lv_font_get_glyph_bitmap(descriptor, fixture.codepoints.A, 0)).not.toBe(0);
    releaseGlyph(raw, descriptor);
  }
  expect(api.lv_cache_get_size(cache, 0)).toBe(128);
  for (const font of fonts.slice(0, 4)) raw.lv_tiny_ttf_destroy(font);
  expect(api.lv_cache_get_size(cache, 0)).toBe(128);
  for (const font of fonts.slice(4)) raw.lv_tiny_ttf_destroy(font);
  expect(api.lv_cache_get_size(cache, 0)).toBe(0);
  raw.lvw_free(descriptor);
  raw.lvw_free(data.pointer);
  runtime.shutdown();
});

test.skipIf(!legacy)("legacy fallback drawing releases the resolved font's glyph", async () => {
  const { runtime, raw, display, label, frame } = await load();
  const api = raw as unknown as LegacyFontApi;
  const data = await fontData(raw, fixture.fallback);
  const size = fixture.sizes[0]!;
  const fallback = createFont(raw, data, size.size);
  const original = raw.lv_obj_get_style_text_font(runtime.screen(display).handle, LV_PART_MAIN);
  const primary = raw.lvw_alloc(sdk.LV_FONT_T_SIZE);
  new Uint8Array(raw.memory.buffer, primary, sdk.LV_FONT_T_SIZE)
    .set(new Uint8Array(raw.memory.buffer, original, sdk.LV_FONT_T_SIZE));
  new DataView(raw.memory.buffer).setUint32(primary + offset(LV_FONT_T_FIELDS, "fallback"), fallback, true);
  expect(new DataView(raw.memory.buffer).getUint32(primary + offset(LV_FONT_T_FIELDS, "release_glyph"), true)).toBe(0);
  const object = label(primary, ["Omega"], 8, 8);
  frame();
  const descriptor = raw.lvw_alloc(LV_FONT_GLYPH_DSC_T_SIZE);
  expect(raw.lv_font_get_glyph_dsc(primary, descriptor, fixture.codepoints.Omega, 0)).toBe(1);
  expect(new DataView(raw.memory.buffer).getUint32(descriptor + offset(LV_FONT_GLYPH_DSC_T_FIELDS, "resolved_font"), true)).toBe(fallback);
  expect(api.lv_font_get_glyph_bitmap(descriptor, fixture.codepoints.Omega, 0)).not.toBe(0);
  const entry = new DataView(raw.memory.buffer).getUint32(descriptor + offset(LV_FONT_GLYPH_DSC_T_FIELDS, "entry"), true);
  expect(api.lv_cache_entry_get_ref(entry)).toBe(1);
  releaseGlyph(raw, descriptor);
  raw.lvw_free(descriptor);
  object.delete();
  raw.lvw_free(primary);
  raw.lv_tiny_ttf_destroy(fallback);
  raw.lvw_free(data.pointer);
  runtime.shutdown();
});
