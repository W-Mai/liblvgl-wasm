import { expect, test } from "bun:test";
import {
  LV_COLOR_T_SIZE, LV_OPA_COVER, LV_PART_MAIN, LvglRuntime, type Frame,
} from "../bindings/typescript/src/index.ts";
import fixture from "./fixtures/png/expected.json";

async function load() {
  const runtime = await LvglRuntime.load(await Bun.file("target/wasm/liblvgl.wasm").arrayBuffer());
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
    expect(raw.lv_image_get_src_width(image.handle)).toBe(fixture.width);
    expect(raw.lv_image_get_src_height(image.handle)).toBe(fixture.height);
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

test("corrupt and unsupported PNGs leave the background intact and valid images recover in the same runtime", async () => {
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
    runtime.setImageSource(image, `W:${name}`);
    expect(raw.lv_image_get_src_width(image.handle)).toBe(fixture.width);
    expect(raw.lv_image_get_src_height(image.handle)).toBe(fixture.height);
    runtime.step(33);
    backgroundPixels(runtime.readFrame(display), 6, 5);
    runtime.setImageSource(image, `W:${valid.file}`);
    runtime.step(33);
    imagePixels(runtime.readFrame(display), 6, 5, valid.alpha);
  }
  runtime.putResource("short.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
  runtime.setImageSource(image, "W:short.png");
  expect(raw.lv_image_get_src(image.handle)).toBe(0);
  runtime.step(33);
  backgroundPixels(runtime.readFrame(display), 6, 5);
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
