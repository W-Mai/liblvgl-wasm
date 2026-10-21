import { expect, test } from "bun:test";
import {
  LV_COLOR_T_SIZE, LV_DRAW_BUF_T_FIELDS, LV_FONT_GLYPH_DSC_T_FIELDS, LV_FONT_GLYPH_DSC_T_SIZE,
  LV_FONT_GLYPH_FORMAT_A8, LV_FONT_GLYPH_FORMAT_VECTOR, LV_FONT_INFO_T_FIELDS, LV_FONT_INFO_T_SIZE, LV_FONT_KERNING_NONE,
  LV_FONT_KERNING_NORMAL, LV_FONT_T_FIELDS, LV_FREETYPE_FONT_RENDER_MODE_BITMAP,
  LV_FREETYPE_FONT_RENDER_MODE_OUTLINE, LV_FREETYPE_FONT_STYLE_NORMAL, LV_IMAGE_HEADER_T_FIELDS, LV_OPA_COVER, LV_PART_MAIN,
  LV_TEXT_LEADING_TRIM_NONE, LvglRuntime, type Frame, type UnsafeLvgl,
} from "../bindings/typescript/src/index.ts";
import fixture from "./fixtures/freetype/expected.json";
import curves from "./fixtures/freetype-outline/expected.json";

type Size = typeof fixture.sizes[number];
type Glyph = keyof Size["glyphs"];
type Fields = readonly { name: string | null; bit_offset: number; bit_width: number | null }[];

function offset(fields: Fields, name: string): number {
  const field = fields.find((item) => item.name === name)!;
  expect(field.bit_offset % 8).toBe(0);
  return field.bit_offset / 8;
}

async function load() {
  const runtime = await LvglRuntime.load(await Bun.file("target/wasm/liblvgl.wasm").arrayBuffer());
  const raw = runtime.unsafe;
  const display = runtime.createDisplay(240, 112);
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
    raw.lv_obj_set_style_text_leading_trim(object.handle, LV_TEXT_LEADING_TRIM_NONE, LV_PART_MAIN);
    runtime.setText(object, names.map((name) => String.fromCodePoint(fixture.codepoints[name])).join(""));
    object.setPosition(x, y);
    return object;
  }
  function frame(): Frame {
    raw.lv_obj_update_layout(screen.handle);
    raw.lv_refr_now(display.handle);
    return runtime.readFrame(display);
  }
  return { runtime, raw, label, frame };
}

async function upload(runtime: LvglRuntime, sample = fixture.font, name = "geometry.ttf") {
  const bytes = await Bun.file(`tests/fixtures/freetype/${sample.file}`).bytes();
  expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(sample.sha256);
  runtime.putResource(name, bytes);
  // The resource owns its copy; later glyph loads must not use these staging bytes.
  bytes.fill(0);
}

function font(raw: UnsafeLvgl, path: string, size: number, kerning: number | null = LV_FONT_KERNING_NORMAL,
              renderMode = LV_FREETYPE_FONT_RENDER_MODE_BITMAP): number {
  const bytes = new TextEncoder().encode(`${path}\0`);
  const pointer = raw.lvw_alloc(bytes.length);
  new Uint8Array(raw.memory.buffer, pointer, bytes.length).set(bytes);
  const info = raw.lvw_alloc(LV_FONT_INFO_T_SIZE);
  try {
    if (kerning === null) {
      return raw.lv_freetype_font_create(pointer, renderMode, size, LV_FREETYPE_FONT_STYLE_NORMAL);
    }
    raw.lv_freetype_init_font_info(info);
    const view = new DataView(raw.memory.buffer);
    for (const [name, value] of [["name", pointer], ["size", size], ["kerning", kerning], ["render_mode", renderMode]] as const) {
      view.setUint32(info + offset(LV_FONT_INFO_T_FIELDS, name), value, true);
    }
    return raw.lv_freetype_font_create_with_info(info);
  } finally {
    // Font creation copies the path and configuration, unlike a borrowed TTF data pointer.
    new Uint8Array(raw.memory.buffer, pointer, bytes.length).fill(0x58);
    new Uint8Array(raw.memory.buffer, info, LV_FONT_INFO_T_SIZE).fill(0x5a);
    raw.lvw_free(info);
    raw.lvw_free(pointer);
  }
}

function glyph(raw: UnsafeLvgl, font: number, name: Glyph, size: Size, resolvedFont = font): void {
  const expected = size.glyphs[name];
  const descriptor = raw.lvw_alloc(LV_FONT_GLYPH_DSC_T_SIZE);
  try {
    expect(raw.lv_font_get_glyph_dsc(font, descriptor, fixture.codepoints[name], 0)).toBe(1);
    let view = new DataView(raw.memory.buffer);
    expect(view.getUint32(descriptor + offset(LV_FONT_GLYPH_DSC_T_FIELDS, "resolved_font"), true)).toBe(resolvedFont);
    expect(view.getUint32(descriptor + offset(LV_FONT_GLYPH_DSC_T_FIELDS, "format"), true)).toBe(LV_FONT_GLYPH_FORMAT_A8);
    for (const [field, value] of [["adv_w", expected.advance], ["box_w", expected.box_w], ["box_h", expected.box_h]] as const) {
      expect(view.getUint16(descriptor + offset(LV_FONT_GLYPH_DSC_T_FIELDS, field), true)).toBe(value);
    }
    for (const field of ["ofs_x", "ofs_y"] as const) {
      expect(view.getInt16(descriptor + offset(LV_FONT_GLYPH_DSC_T_FIELDS, field), true)).toBe(expected[field]);
    }
    if (!expected.box_w || !expected.box_h) return;
    const buffer = raw.lv_font_get_glyph_bitmap(descriptor, 0);
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
    raw.lv_font_glyph_release_draw_data(descriptor);
    raw.lvw_free(descriptor);
  }
}

function textWidth(size: Size, names: Glyph[], kerning = true): number {
  return names.reduce((width, name, index) => width + size.glyphs[name].advance
    - (kerning && name === "A" && names[index + 1] === "B" ? size.kerning : 0), 0);
}

function textPixels(frame: Frame, size: Size, names: Glyph[], x: number, y: number, kerning = true,
                    outlineNames: readonly Glyph[] = [], outlineOpacity = LV_OPA_COVER): void {
  const width = textWidth(size, names, kerning);
  const mask = Array.from({ length: size.line_height }, () => new Float64Array(width));
  let pen = 0;
  for (let index = 0; index < names.length; index++) {
    const name = names[index]!;
    const expected = size.glyphs[name];
    const top = size.line_height - size.baseline - expected.box_h - expected.ofs_y;
    for (let row = 0; row < expected.box_h; row++) {
      for (let column = 0; column < expected.box_w; column++) {
        const coverage = expected.alpha[row]![column]!;
        mask[top + row]![pen + expected.ofs_x + column] = outlineNames.includes(name)
          ? coverage * Math.floor(255 * outlineOpacity / 256) / 255 : coverage;
      }
    }
    pen += expected.advance - (kerning && name === "A" && names[index + 1] === "B" ? size.kerning : 0);
  }
  for (let row = -1; row <= size.line_height; row++) {
    for (let column = -1; column <= width; column++) {
      const alpha = mask[row]?.[column] ?? 0;
      const pixel = ((y + row) * frame.width + x + column) * 4;
      for (let channel = 0; channel < 3; channel++) {
        // Independent source-over truncates once; raster quantization and blending can each truncate.
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

test("FreeType renders geometric glyphs and fallback with explicitly configured pixel kerning", async () => {
  const { runtime, raw, label, frame } = await load();
  await upload(runtime);
  await upload(runtime, fixture.fallback, "fallback.ttf");
  const names: Glyph[] = ["A", "B", "space", "Aacute", "space", "Omega"];
  for (const size of fixture.sizes) {
    const primary = font(raw, "W:geometry.ttf", size.size);
    const fallback = font(raw, "W:fallback.ttf", size.size);
    const defaultKerning = font(raw, "W:geometry.ttf", size.size, null);
    for (const pointer of [primary, fallback, defaultKerning]) expect(pointer).not.toBe(0);
    expect(raw.lv_font_get_line_height(primary)).toBe(size.line_height);
    const view = new DataView(raw.memory.buffer);
    expect(view.getInt32(primary + offset(LV_FONT_T_FIELDS, "base_line"), true)).toBe(size.baseline);
    view.setUint32(primary + offset(LV_FONT_T_FIELDS, "fallback"), fallback, true);
    for (const name of ["A", "B", "Aacute", "space"] as const) glyph(raw, primary, name, size);
    glyph(raw, primary, "Omega", size, fallback);
    expect(raw.lv_font_get_glyph_width(defaultKerning, fixture.codepoints.A, fixture.codepoints.B)).toBe(size.glyphs.A.advance);
    expect(raw.lv_font_get_glyph_width(primary, fixture.codepoints.A, fixture.codepoints.B)).toBe(size.glyphs.A.advance - size.kerning);
    raw.lv_font_set_kerning(primary, LV_FONT_KERNING_NONE);
    expect(raw.lv_font_get_glyph_width(primary, fixture.codepoints.A, fixture.codepoints.B)).toBe(size.glyphs.A.advance);
    raw.lv_font_set_kerning(primary, LV_FONT_KERNING_NORMAL);
    const object = label(primary, names, 8, 8);
    textPixels(frame(), size, names, 8, 8);
    expect(raw.lv_obj_get_width(object.handle)).toBe(textWidth(size, names));
    expect(raw.lv_obj_get_height(object.handle)).toBe(size.line_height);
    object.delete();
    raw.lv_freetype_font_delete(defaultKerning);
    raw.lv_freetype_font_delete(primary);
    raw.lv_freetype_font_delete(fallback);
  }
  runtime.shutdown();
});

test("shared FreeType faces keep font sizes and users independent until their last reference is deleted", async () => {
  const { runtime, raw, label, frame } = await load();
  await upload(runtime);
  const small = fixture.sizes[0]!;
  const large = fixture.sizes[1]!;
  const smallFont = font(raw, "W:geometry.ttf", small.size);
  const largeFont = font(raw, "W:geometry.ttf", large.size);
  expect(smallFont).not.toBe(0);
  expect(largeFont).not.toBe(0);
  const first = label(smallFont, ["A", "B"], 8, 8);
  const second = label(smallFont, ["B"], 8, 64);
  const before = frame();
  textPixels(before, small, ["A", "B"], 8, 8);
  textPixels(before, small, ["B"], 8, 64);
  for (const [pointer, size] of [[largeFont, large], [smallFont, small], [largeFont, large]] as const) {
    glyph(raw, pointer, "Aacute", size);
    expect(raw.lv_font_get_glyph_width(pointer, fixture.codepoints.A, fixture.codepoints.B)).toBe(size.glyphs.A.advance - size.kerning);
  }
  first.delete();
  textPixels(frame(), small, ["B"], 8, 64);
  raw.lv_obj_set_style_text_font(second.handle, largeFont, LV_PART_MAIN);
  raw.lv_freetype_font_delete(smallFont);
  runtime.setText(second, "ÁB");
  textPixels(frame(), large, ["Aacute", "B"], 8, 64);
  expect(raw.lv_obj_get_width(second.handle)).toBe(textWidth(large, ["Aacute", "B"]));
  expect(raw.lv_obj_get_height(second.handle)).toBe(large.line_height);
  second.delete();
  raw.lv_freetype_font_delete(largeFont);
  const reopened = font(raw, "W:geometry.ttf", small.size);
  expect(reopened).not.toBe(0);
  const replacement = label(reopened, ["Aacute"], 8, 8);
  textPixels(frame(), small, ["Aacute"], 8, 8);
  replacement.delete();
  raw.lv_freetype_font_delete(reopened);
  runtime.step(33);
  runtime.shutdown();
});

test("FreeType contains font parsing failures and remains usable after cmap recovery", async () => {
  const { runtime, raw, label, frame } = await load();
  const bytes = await Bun.file(`tests/fixtures/freetype/${fixture.font.file}`).bytes();
  for (const sample of fixture.rejected) {
    runtime.putResource(sample.name, "bytes" in sample ? new Uint8Array(sample.bytes!) : bytes.slice(0, sample.length));
  }
  await upload(runtime);
  const size = fixture.sizes[0]!;
  const recovery = fixture.cmap_recovery;
  expect(Array.from(bytes.slice(recovery.offset, recovery.offset + recovery.original.length))).toEqual(recovery.original);
  const damagedCmap = bytes.slice();
  damagedCmap.set(recovery.bytes, recovery.offset);
  runtime.putResource(recovery.name, damagedCmap);
  // The invalid segment count triggers validator longjmp; glyph names supply a replacement charmap.
  const repaired = font(raw, `W:${recovery.name}`, size.size);
  expect(repaired).not.toBe(0);
  glyph(raw, repaired, "A", size);
  glyph(raw, repaired, "Aacute", size);
  raw.lv_freetype_font_delete(repaired);
  const original = font(raw, "W:geometry.ttf", size.size);
  expect(original).not.toBe(0);
  glyph(raw, original, "Aacute", size);
  raw.lv_freetype_font_delete(original);
  expect(raw.lv_freetype_font_create(0, LV_FREETYPE_FONT_RENDER_MODE_BITMAP, size.size, LV_FREETYPE_FONT_STYLE_NORMAL)).toBe(0);
  expect(font(raw, "W:geometry.ttf", 0)).toBe(0);
  for (const path of ["", "W:missing.ttf", ...fixture.rejected.map((sample) => `W:${sample.name}`)]) {
    expect(font(raw, path, size.size)).toBe(0);
    runtime.step(1);
    const recovered = font(raw, "W:geometry.ttf", size.size);
    expect(recovered).not.toBe(0);
    glyph(raw, recovered, "Aacute", size);
    const object = label(recovered, ["A", "B"], 8, 8);
    textPixels(frame(), size, ["A", "B"], 8, 8);
    object.delete();
    raw.lv_freetype_font_delete(recovered);
  }
  raw.lv_freetype_font_delete(0);
  runtime.shutdown();
});

function outlineGlyph(raw: UnsafeLvgl, pointer: number, name: Glyph, size: Size,
                      resolvedFont = pointer): number {
  const expected = size.glyphs[name];
  const descriptor = raw.lvw_alloc(LV_FONT_GLYPH_DSC_T_SIZE);
  expect(raw.lv_font_get_glyph_dsc(pointer, descriptor, fixture.codepoints[name], 0)).toBe(1);
  const view = new DataView(raw.memory.buffer);
  expect(view.getUint32(descriptor + offset(LV_FONT_GLYPH_DSC_T_FIELDS, "resolved_font"), true)).toBe(resolvedFont);
  expect(view.getUint32(descriptor + offset(LV_FONT_GLYPH_DSC_T_FIELDS, "format"), true)).toBe(LV_FONT_GLYPH_FORMAT_VECTOR);
  for (const [field, value] of [["adv_w", expected.advance], ["box_w", expected.box_w], ["box_h", expected.box_h]] as const) {
    expect(view.getUint16(descriptor + offset(LV_FONT_GLYPH_DSC_T_FIELDS, field), true)).toBe(value);
  }
  for (const field of ["ofs_x", "ofs_y"] as const) {
    expect(view.getInt16(descriptor + offset(LV_FONT_GLYPH_DSC_T_FIELDS, field), true)).toBe(expected[field]);
  }
  if (expected.box_w && expected.box_h) {
    // Outline draw data is an opaque native path, not an A8 draw buffer.
    expect(raw.lv_font_get_glyph_bitmap(descriptor, 0)).not.toBe(0);
    expect(new DataView(raw.memory.buffer).getUint32(descriptor + offset(LV_FONT_GLYPH_DSC_T_FIELDS, "entry"), true)).not.toBe(0);
  }
  return descriptor;
}

function releaseOutline(raw: UnsafeLvgl, descriptor: number): void {
  raw.lv_font_glyph_release_draw_data(descriptor);
  expect(new DataView(raw.memory.buffer).getUint32(descriptor + offset(LV_FONT_GLYPH_DSC_T_FIELDS, "entry"), true)).toBe(0);
  raw.lvw_free(descriptor);
}

test("FreeType outlines render geometric coverage, metrics and text opacity through the native vector backend", async () => {
  const { runtime, raw, label, frame } = await load();
  await upload(runtime);
  await upload(runtime, fixture.fallback, "fallback.ttf");
  const names: Glyph[] = ["A", "B", "space", "Aacute", "space", "Omega"];
  for (const size of fixture.sizes) {
    const primary = font(raw, "W:geometry.ttf", size.size, LV_FONT_KERNING_NORMAL, LV_FREETYPE_FONT_RENDER_MODE_OUTLINE);
    const fallback = font(raw, "W:fallback.ttf", size.size, LV_FONT_KERNING_NORMAL, LV_FREETYPE_FONT_RENDER_MODE_OUTLINE);
    for (const pointer of [primary, fallback]) {
      expect(pointer).not.toBe(0);
      expect(raw.lv_freetype_is_outline_font(pointer)).toBe(1);
      expect(raw.lv_freetype_outline_get_scale(pointer)).toBe(size.size * 64 / 128);
      expect(raw.lv_font_get_line_height(pointer)).toBe(size.line_height);
      expect(new DataView(raw.memory.buffer).getInt32(pointer + offset(LV_FONT_T_FIELDS, "base_line"), true)).toBe(size.baseline);
    }
    new DataView(raw.memory.buffer).setUint32(primary + offset(LV_FONT_T_FIELDS, "fallback"), fallback, true);
    const object = label(primary, names, 8, 8);
    for (const opacity of [255, 128]) {
      raw.lv_obj_set_style_text_opa(object.handle, opacity, LV_PART_MAIN);
      for (let redraw = 0; redraw < 2; redraw++) {
        raw.lv_obj_invalidate(object.handle);
        textPixels(frame(), size, names, 8, 8, true, names, opacity);
      }
    }
    expect(raw.lv_obj_get_width(object.handle)).toBe(textWidth(size, names));
    expect(raw.lv_obj_get_height(object.handle)).toBe(size.line_height);
    // The first label refresh installs the native outline callback before manual borrowing.
    for (const name of ["A", "B", "Aacute", "space", "Omega"] as const) {
      releaseOutline(raw, outlineGlyph(raw, primary, name, size, name === "Omega" ? fallback : primary));
    }
    object.delete();
    new DataView(raw.memory.buffer).setUint32(primary + offset(LV_FONT_T_FIELDS, "fallback"), 0, true);
    raw.lv_freetype_font_delete(primary);
    raw.lv_freetype_font_delete(fallback);
  }
  runtime.shutdown();
});

test("FreeType outline paths survive shared-font redraws until manual glyph borrows and font users are released", async () => {
  const { runtime, raw, label, frame } = await load();
  await upload(runtime);
  const small = fixture.sizes[0]!;
  const large = fixture.sizes[1]!;
  const smallFont = font(raw, "W:geometry.ttf", small.size, LV_FONT_KERNING_NORMAL, LV_FREETYPE_FONT_RENDER_MODE_OUTLINE);
  const largeFont = font(raw, "W:geometry.ttf", large.size, LV_FONT_KERNING_NORMAL, LV_FREETYPE_FONT_RENDER_MODE_OUTLINE);
  expect(smallFont).not.toBe(0);
  expect(largeFont).not.toBe(0);
  const first = label(smallFont, ["Aacute"], 8, 8);
  const second = label(smallFont, ["A", "B"], 8, 64);
  let image = frame();
  textPixels(image, small, ["Aacute"], 8, 8, true, ["Aacute"]);
  textPixels(image, small, ["A", "B"], 8, 64, true, ["A", "B"]);
  const borrowed = outlineGlyph(raw, smallFont, "Aacute", small);
  for (const [pointer, size] of [[largeFont, large], [smallFont, small], [largeFont, large]] as const) {
    raw.lv_obj_set_style_text_font(first.handle, pointer, LV_PART_MAIN);
    raw.lv_obj_invalidate(first.handle);
    image = frame();
    textPixels(image, size, ["Aacute"], 8, 8, true, ["Aacute"]);
    textPixels(image, small, ["A", "B"], 8, 64, true, ["A", "B"]);
  }
  first.delete();
  textPixels(frame(), small, ["A", "B"], 8, 64, true, ["A", "B"]);
  raw.lv_obj_set_style_text_font(second.handle, largeFont, LV_PART_MAIN);
  releaseOutline(raw, borrowed);
  raw.lv_freetype_font_delete(smallFont);
  runtime.setText(second, "ÁB");
  textPixels(frame(), large, ["Aacute", "B"], 8, 64, true, ["Aacute", "B"]);
  second.delete();
  raw.lv_freetype_font_delete(largeFont);
  const reopened = font(raw, "W:geometry.ttf", small.size, LV_FONT_KERNING_NORMAL, LV_FREETYPE_FONT_RENDER_MODE_OUTLINE);
  expect(reopened).not.toBe(0);
  const replacement = label(reopened, ["Aacute"], 8, 8);
  textPixels(frame(), small, ["Aacute"], 8, 8, true, ["Aacute"]);
  replacement.delete();
  raw.lv_freetype_font_delete(reopened);
  runtime.step(33);
  runtime.shutdown();
});

test("FreeType fallback resolves bitmap and outline glyphs with their own draw-data ownership", async () => {
  const { runtime, raw, label, frame } = await load();
  await upload(runtime);
  await upload(runtime, fixture.fallback, "fallback.ttf");
  const size = fixture.sizes[0]!;
  for (const primaryMode of [LV_FREETYPE_FONT_RENDER_MODE_BITMAP, LV_FREETYPE_FONT_RENDER_MODE_OUTLINE]) {
    const fallbackMode = primaryMode === LV_FREETYPE_FONT_RENDER_MODE_BITMAP
      ? LV_FREETYPE_FONT_RENDER_MODE_OUTLINE : LV_FREETYPE_FONT_RENDER_MODE_BITMAP;
    const primary = font(raw, "W:geometry.ttf", size.size, LV_FONT_KERNING_NORMAL, primaryMode);
    const fallback = font(raw, "W:fallback.ttf", size.size, LV_FONT_KERNING_NORMAL, fallbackMode);
    expect(primary).not.toBe(0);
    expect(fallback).not.toBe(0);
    expect(raw.lv_freetype_is_outline_font(primary)).toBe(primaryMode === LV_FREETYPE_FONT_RENDER_MODE_OUTLINE ? 1 : 0);
    expect(raw.lv_freetype_is_outline_font(fallback)).toBe(fallbackMode === LV_FREETYPE_FONT_RENDER_MODE_OUTLINE ? 1 : 0);
    new DataView(raw.memory.buffer).setUint32(primary + offset(LV_FONT_T_FIELDS, "fallback"), fallback, true);
    const names: Glyph[] = ["Aacute", "space", "Omega"];
    const outlined: Glyph[] = primaryMode === LV_FREETYPE_FONT_RENDER_MODE_OUTLINE ? ["Aacute", "space"] : ["Omega"];
    const object = label(primary, names, 8, 8);
    textPixels(frame(), size, names, 8, 8, true, outlined);
    if (fallbackMode === LV_FREETYPE_FONT_RENDER_MODE_OUTLINE) {
      releaseOutline(raw, outlineGlyph(raw, primary, "Omega", size, fallback));
      glyph(raw, primary, "Aacute", size);
    } else {
      glyph(raw, primary, "Omega", size, fallback);
      releaseOutline(raw, outlineGlyph(raw, primary, "Aacute", size));
    }
    raw.lv_obj_invalidate(object.handle);
    textPixels(frame(), size, names, 8, 8, true, outlined);
    object.delete();
    new DataView(raw.memory.buffer).setUint32(primary + offset(LV_FONT_T_FIELDS, "fallback"), 0, true);
    raw.lv_freetype_font_delete(primary);
    raw.lv_freetype_font_delete(fallback);
  }
  runtime.shutdown();
});

test("FreeType quadratic and cubic outlines stay within analytic curve bounds at even and odd font sizes", async () => {
  const { runtime, raw, label, frame } = await load();
  expect(curves.background).toEqual(fixture.background);
  expect(curves.foreground).toEqual(fixture.foreground);
  for (const sample of curves.fonts) {
    await upload(runtime, { ...sample, file: `../freetype-outline/${sample.file}` }, sample.file);
    for (const size of curves.sizes) {
      const pointer = font(raw, `W:${sample.file}`, size.size, LV_FONT_KERNING_NORMAL, LV_FREETYPE_FONT_RENDER_MODE_OUTLINE);
      expect(pointer).not.toBe(0);
      expect(raw.lv_freetype_is_outline_font(pointer)).toBe(1);
      expect(raw.lv_font_get_line_height(pointer)).toBe(size.line_height);
      expect(raw.lv_font_get_glyph_width(pointer, curves.codepoint, 0)).toBe(size.advance);
      expect(new DataView(raw.memory.buffer).getInt32(pointer + offset(LV_FONT_T_FIELDS, "base_line"), true)).toBe(size.baseline);
      const object = label(pointer, [], 8, 8);
      runtime.setText(object, String.fromCodePoint(curves.codepoint));
      for (const opacity of [255, 128]) {
        raw.lv_obj_set_style_text_opa(object.handle, opacity, LV_PART_MAIN);
        for (let redraw = 0; redraw < 2; redraw++) {
          raw.lv_obj_invalidate(object.handle);
          const image = frame();
          for (let row = -1; row <= size.line_height; row++) {
            for (let column = -1; column <= size.advance; column++) {
              const minimum = size.coverage_min[row]?.[column] ?? 0;
              const maximum = size.coverage_max[row]?.[column] ?? 0;
              const alphaMin = minimum * Math.floor(255 * opacity / 256) / 255;
              const alphaMax = maximum * Math.floor(255 * opacity / 256) / 255;
              const pixel = ((8 + row) * image.width + 8 + column) * 4;
              for (let channel = 0; channel < 3; channel++) {
                const composite = (alpha: number) => Math.floor((curves.foreground[channel]! * alpha
                  + curves.background[channel]! * (255 - alpha)) / 255);
                const lower = composite(alphaMin);
                const upper = composite(alphaMax);
                const actual = image.rgba[pixel + channel]!;
                const tolerance = maximum === 0 ? 0 : 2;
                const context = `${sample.kind} ${size.size}px opacity ${opacity} (${column}, ${row}) channel ${channel}: ${actual} vs [${lower}, ${upper}]`;
                expect(actual, context).toBeGreaterThanOrEqual(lower - tolerance);
                expect(actual, context).toBeLessThanOrEqual(upper + tolerance);
              }
              expect(image.rgba[pixel + 3]).toBe(255);
            }
          }
        }
      }
      expect(raw.lv_obj_get_width(object.handle)).toBe(size.advance);
      expect(raw.lv_obj_get_height(object.handle)).toBe(size.line_height);
      object.delete();
      raw.lv_freetype_font_delete(pointer);
    }
  }
  runtime.shutdown();
});
