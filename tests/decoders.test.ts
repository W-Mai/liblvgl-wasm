import { expect, test } from "bun:test";
import type { LvglRuntime, DecoderSession, Frame, ImageDecoderCallbacks } from "../bindings/typescript/src/index.ts";

const sdk = await import(Bun.env.LVW_TEST_TS_RUNTIME ?? "../bindings/typescript/src/index.ts") as
  typeof import("../bindings/typescript/src/index.ts") & {
    LV_IMAGE_DECODER_DSC_T_SIZE?: number;
    LV_IMAGE_DECODER_DSC_T_FIELDS?: readonly { name: string | null; bit_offset: number; bit_width: number | null }[];
  };
const {
  LV_AREA_T_FIELDS, LV_COLOR_FORMAT_ARGB8888, LV_COORD_MIN, LV_EVENT_DELETE,
  LV_FS_FILE_T_SIZE, LV_FS_MODE_RD, LV_FS_RES_OK, LV_IMAGE_HEADER_MAGIC,
  LV_IMAGE_HEADER_T_FIELDS, LV_IMAGE_HEADER_T_SIZE, LV_IMAGE_SRC_FILE,
  LV_RESULT_INVALID, LV_RESULT_OK, LV_STRIDE_AUTO,
  LV_IMAGE_HEADER_CACHE_DEF_CNT,
} = sdk;
const legacy = Number(sdk.LVGL_VERSION_MINOR) === 0;

async function load(): Promise<LvglRuntime> {
  return sdk.LvglRuntime.load(await Bun.file(Bun.env.LVW_TEST_CORE ?? "target/wasm/liblvgl.wasm").arrayBuffer());
}

function pixel(frame: Frame, x: number, y: number): number[] {
  const start = (y * frame.width + x) * 4;
  return [...frame.rgba.subarray(start, start + 4)];
}

function header(runtime: LvglRuntime, pointer: number, width: number, height: number): void {
  const data = new DataView(runtime.unsafe.memory.buffer);
  new Uint8Array(data.buffer, pointer, LV_IMAGE_HEADER_T_SIZE).fill(0);
  const values: Record<string, number> = {
    magic: LV_IMAGE_HEADER_MAGIC, cf: LV_COLOR_FORMAT_ARGB8888, w: width, h: height, stride: width * 4,
  };
  for (const field of LV_IMAGE_HEADER_T_FIELDS) {
    const value = values[field.name];
    if (value === undefined) continue;
    if (field.bit_width === 8) data.setUint8(pointer + field.bit_offset / 8, value);
    else data.setUint16(pointer + field.bit_offset / 8, value, true);
  }
}

function fileBytes(runtime: LvglRuntime, file: number, length: number): Uint8Array {
  const raw = runtime.unsafe;
  const pointer = raw.lvw_alloc(length + 4);
  try {
    expect(raw.lv_fs_read(file, pointer, length, pointer + length)).toBe(LV_FS_RES_OK);
    expect(new DataView(raw.memory.buffer).getUint32(pointer + length, true)).toBe(length);
    return new Uint8Array(raw.memory.buffer, pointer, length).slice();
  } finally {
    raw.lvw_free(pointer);
  }
}

function resource(): Uint8Array {
  const bytes = new Uint8Array(8 + 4 * 3 * 4);
  bytes.set([76, 86, 87, 33, 4, 3, 0, 0]);
  for (let y = 0; y < 3; y++) {
    for (let x = 0; x < 4; x++) bytes.set([0x30 + x, 0x50 + y, 0x90, 255], 8 + (y * 4 + x) * 4);
  }
  return bytes;
}

function register(runtime: LvglRuntime, chunked = false, failOpen = false,
                  visit?: (session: DecoderSession) => void) {
  const raw = runtime.unsafe;
  const counts = { opened: 0, closed: 0, rows: 0, rejected: 0, rolledBack: 0 };
  const sources = new Map<number, Uint8Array>();
  const callbacks: ImageDecoderCallbacks = {
    info(session, output) {
      visit?.(session);
      const view = session.read();
      expect(view.srcType).toBe(LV_IMAGE_SRC_FILE);
      expect(view.header).toBe(output);
      expect(view.decoderUserData).toBe(0xf1234567);
      expect(view.file === 0).toBe(legacy);
      expect(view.argsFlags & 16).toBe(0);
      const file = legacy ? raw.lvw_alloc(LV_FS_FILE_T_SIZE) : view.file;
      if (legacy) expect(raw.lv_fs_open(file, view.src, LV_FS_MODE_RD)).toBe(LV_FS_RES_OK);
      const bytes = fileBytes(runtime, file, 8);
      if (legacy) {
        expect(raw.lv_fs_close(file)).toBe(LV_FS_RES_OK);
        raw.lvw_free(file);
      }
      if (!bytes.subarray(0, 4).every((value, index) => value === [76, 86, 87, 33][index])) {
        counts.rejected++;
        return LV_RESULT_INVALID;
      }
      header(runtime, output, bytes[4]!, bytes[5]!);
      return LV_RESULT_OK;
    },
    open(session) {
      visit?.(session);
      const view = session.read();
      const file = raw.lvw_alloc(LV_FS_FILE_T_SIZE);
      expect(raw.lv_fs_open(file, view.src, LV_FS_MODE_RD)).toBe(LV_FS_RES_OK);
      const bytes = fileBytes(runtime, file, resource().length);
      expect(raw.lv_fs_close(file)).toBe(LV_FS_RES_OK);
      raw.lvw_free(file);
      const buffer = raw.lv_draw_buf_create(bytes[4]!, chunked ? 1 : bytes[5]!, LV_COLOR_FORMAT_ARGB8888, LV_STRIDE_AUTO);
      expect(buffer).not.toBe(0);
      if (failOpen) {
        raw.lv_draw_buf_destroy(buffer);
        counts.rolledBack++;
        return LV_RESULT_INVALID;
      }
      if (chunked) sources.set(buffer, bytes);
      else {
        for (let y = 0; y < bytes[5]!; y++) {
          new Uint8Array(raw.memory.buffer, raw.lv_draw_buf_goto_xy(buffer, 0, y), bytes[4]! * 4)
            .set(bytes.subarray(8 + y * bytes[4]! * 4, 8 + (y + 1) * bytes[4]! * 4));
        }
      }
      session.write({ decoded: chunked ? 0 : buffer, userData: buffer, timeToOpen: 7 });
      expect(session.read().timeToOpen).toBe(7);
      counts.opened++;
      return LV_RESULT_OK;
    },
    close(session) {
      visit?.(session);
      const view = session.read();
      raw.lv_draw_buf_destroy(view.userData);
      sources.delete(view.userData);
      session.write({ decoded: 0 });
      expect(session.read().userData).toBe(0);
      counts.closed++;
    },
  };
  if (chunked) callbacks.getArea = (session, fullArea, decodedArea) => {
    visit?.(session);
    const view = session.read();
    const data = new DataView(raw.memory.buffer);
    const read = (pointer: number, name: string) =>
      data.getInt32(pointer + LV_AREA_T_FIELDS.find((field) => field.name === name)!.bit_offset / 8, true);
    const previous = read(decodedArea, "y1");
    const y = previous === LV_COORD_MIN ? read(fullArea, "y1") : previous + 1;
    if (y > read(fullArea, "y2")) return LV_RESULT_INVALID;
    const x1 = read(fullArea, "x1");
    const x2 = read(fullArea, "x2");
    for (const field of LV_AREA_T_FIELDS) {
      data.setInt32(decodedArea + field.bit_offset / 8,
        field.name === "x1" ? x1 : field.name === "x2" ? x2 : y, true);
    }
    const bytes = sources.get(view.userData)!;
    new Uint8Array(raw.memory.buffer, raw.lv_draw_buf_goto_xy(view.userData, 0, 0), (x2 - x1 + 1) * 4)
      .set(bytes.subarray(8 + (y * bytes[4]! + x1) * 4, 8 + (y * bytes[4]! + x2 + 1) * 4));
    session.write({ decoded: view.userData, userData: view.userData });
    counts.rows++;
    return LV_RESULT_OK;
  };
  return { decoder: runtime.createImageDecoder(callbacks, 0xf1234567), counts, sources };
}

test("native decoding renders complete and row-based images and releases every successful session", async () => {
  for (const chunked of [false, true]) {
    const runtime = await load();
    const display = runtime.createDisplay(48, 32);
    runtime.putResource("pixels.custom", resource());
    const { decoder, counts, sources } = register(runtime, chunked);
    const image = runtime.createImage(runtime.screen(display));
    image.setPosition(8, 8);
    runtime.setImageSource(image, "W:pixels.custom");
    runtime.step(33);
    const frame = runtime.readFrame(display);
    expect(frame.frameId).toBeGreaterThan(0);
    expect(pixel(frame, 8, 8)).toEqual([0x90, 0x50, 0x30, 255]);
    expect(pixel(frame, 11, 10)).toEqual([0x90, 0x52, 0x33, 255]);
    expect(counts.opened).toBeGreaterThan(0);
    expect(counts.closed).toBe(counts.opened);
    expect(counts.rows).toBe(chunked ? counts.opened * 3 : 0);
    expect(sources.size).toBe(0);
    decoder.cancel();
    expect(() => decoder.handle).toThrow("invalid");
    runtime.shutdown();
  }
});

test("format rejection falls back to BMP and failed opens roll back without a close notification", async () => {
  const runtime = await load();
  const display = runtime.createDisplay(48, 32);
  runtime.putResource("red.bmp", await Bun.file("examples/browser/red.bmp").bytes());
  runtime.putResource("failed.custom", resource());
  const { decoder, counts } = register(runtime, false, true);
  const image = runtime.createImage(runtime.screen(display));
  runtime.setImageSource(image, "W:failed.custom");
  runtime.step(33);
  expect(counts.rolledBack).toBeGreaterThan(0);
  expect(counts.closed).toBe(0);
  runtime.setImageSource(image, "W:red.bmp");
  image.setPosition(8, 8);
  runtime.step(33);
  expect(pixel(runtime.readFrame(display), 8, 8)).toEqual([255, 0, 0, 255]);
  expect(counts.rejected).toBeGreaterThan(0);
  decoder.cancel();
  decoder.cancel();
  runtime.shutdown();
});

test("decoder sessions enforce innermost borrowing and cancellation preserves busy registrations", async () => {
  const runtime = await load();
  const other = await load();
  const raw = runtime.unsafe;
  const display = runtime.createDisplay(48, 32);
  runtime.putResource("pixels.custom", resource());
  const sourceBytes = new TextEncoder().encode("W:pixels.custom\0");
  const source = raw.lvw_alloc(sourceBytes.length);
  new Uint8Array(raw.memory.buffer, source, sourceBytes.length).set(sourceBytes);
  const output = raw.lvw_alloc(LV_IMAGE_HEADER_T_SIZE);
  let saved: DecoderSession | undefined;
  let outer: DecoderSession | undefined;
  let nested = 0;
  const { decoder, counts } = register(runtime, false, false, (session) => {
    const view = session.read();
    saved = session;
    expect(Object.isFrozen(view)).toBe(true);
    expect(session.pointer).not.toBe(0);
    expect(session.decoder.handle).toBe(decoder.handle);
    expect(() => decoder.cancel()).toThrow("(-3)");
    expect(() => runtime.step(1)).toThrow("not reentrant");
    if (view.phase !== 1) return;
    expect(() => session.write({ decoded: 0 })).toThrow("info callback");
    if (outer) {
      expect(() => outer!.read()).toThrow("innermost");
      expect(() => outer!.pointer).toThrow("innermost");
      nested++;
    } else {
      outer = session;
      expect(raw.lv_image_decoder_get_info(source, output)).toBe(LV_RESULT_OK);
      expect(session.read().src).toBe(view.src);
      outer = undefined;
    }
  });
  expect(() => other.cancelImageDecoder(decoder)).toThrow("invalid");
  const image = runtime.createImage(runtime.screen(display));
  runtime.setImageSource(image, "W:pixels.custom");
  runtime.step(33);
  expect(counts.closed).toBeGreaterThan(0);
  expect(nested).toBeGreaterThan(0);
  for (const access of [() => saved!.read(), () => saved!.write({ decoded: 0 }),
    () => saved!.pointer, () => saved!.decoder]) expect(access).toThrow("innermost");
  // The rendered source can hold a cached header pointing to this decoder.
  decoder.cancel();
  expect(() => decoder.handle).toThrow("invalid");
  decoder.cancel();
  const idle = runtime.createImageDecoder({ info: () => 0, open: () => 0 });
  raw.lv_image_decoder_delete(idle.handle);
  expect(() => idle.handle).toThrow("invalid");
  const replacement = runtime.createImageDecoder({ info: () => 0, open: () => 0 });
  runtime.screen(display).on(LV_EVENT_DELETE, () => {
    expect(() => replacement.handle).toThrow("closing");
    replacement.cancel();
  });
  raw.lvw_free(source);
  raw.lvw_free(output);
  runtime.shutdown();
  expect(() => replacement.handle).toThrow("closed");
  replacement.cancel();
  other.shutdown();
});

test("managed cancellation drops cached headers before a replacement decoder is queried", async () => {
  const runtime = await load();
  const raw = runtime.unsafe;
  runtime.putResource("cached.custom", resource());
  const bytes = new TextEncoder().encode("W:cached.custom\0");
  const source = raw.lvw_alloc(bytes.length);
  new Uint8Array(raw.memory.buffer, source, bytes.length).set(bytes);
  const output = raw.lvw_alloc(LV_IMAGE_HEADER_T_SIZE);
  let calls = 0;
  const create = () => runtime.createImageDecoder({
    info(_session, result) { calls++; header(runtime, result, 4, 3); return LV_RESULT_OK; },
    open: () => LV_RESULT_INVALID,
  });
  const first = create();
  expect(raw.lv_image_decoder_get_info(source, output)).toBe(LV_RESULT_OK);
  expect(raw.lv_image_decoder_get_info(source, output)).toBe(LV_RESULT_OK);
  expect(calls).toBe(Number(LV_IMAGE_HEADER_CACHE_DEF_CNT) > 0 ? 1 : 2);
  first.cancel();
  const before = calls;
  create();
  expect(raw.lv_image_decoder_get_info(source, output)).toBe(LV_RESULT_OK);
  expect(calls).toBe(before + 1);
  raw.lvw_free(source);
  raw.lvw_free(output);
  // Shutdown must release decoders without using a destroyed header cache.
  runtime.shutdown();
});

test("failed legacy file opens release the native source copy without closing the session", async () => {
  if (!legacy) return;
  const runtime = await load();
  const raw = runtime.unsafe;
  runtime.putResource("failed.custom", resource());
  const bytes = new TextEncoder().encode("W:failed.custom\0");
  const source = raw.lvw_alloc(bytes.length);
  new Uint8Array(raw.memory.buffer, source, bytes.length).set(bytes);
  const descriptor = raw.lvw_alloc(sdk.LV_IMAGE_DECODER_DSC_T_SIZE!);
  const field = sdk.LV_IMAGE_DECODER_DSC_T_FIELDS!.find((field) => field.name === "src")!;
  expect(field.bit_width).toBeNull();
  expect(field.bit_offset % 8).toBe(0);
  const { decoder, counts } = register(runtime, false, true);
  for (let index = 0; index < 8; index++) {
    expect(raw.lv_image_decoder_open(descriptor, source, 0)).toBe(LV_RESULT_INVALID);
    expect(new DataView(raw.memory.buffer).getUint32(descriptor + field.bit_offset / 8, true)).toBe(0);
  }
  expect(counts.rolledBack).toBe(8);
  expect(counts.closed).toBe(0);
  decoder.cancel();
  raw.lvw_free(descriptor);
  raw.lvw_free(source);
  runtime.shutdown();
});

test("decoder callback errors, invalid results, and asynchronous results poison the shared runtime", async () => {
  for (const failure of ["throw", "caught trap", "invalid result", "thenable"] as const) {
    const runtime = await load();
    const raw = runtime.unsafe;
    const display = runtime.createDisplay(48, 32);
    runtime.putResource("pixels.custom", resource());
    const marker = new Error("decoder failure");
    let saved: DecoderSession | undefined;
    const decoder = runtime.createImageDecoder({
      info(session) {
        saved = session;
        if (failure === "throw") throw marker;
        if (failure === "caught trap") {
          expect(() => raw.lv_color_to_int(raw.memory.buffer.byteLength - 1)).toThrow(WebAssembly.RuntimeError);
          return 0;
        }
        return (failure === "thenable" ? Promise.reject(marker) : 2) as unknown as 0;
      },
      open: () => 0,
    });
    const image = runtime.createImage(runtime.screen(display));
    let escaped: unknown;
    try { runtime.setImageSource(image, "W:pixels.custom"); } catch (error) { escaped = error; }
    expect(escaped).toBeDefined();
    if (failure === "throw") expect(escaped).toBe(marker);
    expect(() => decoder.handle).toThrow("poisoned");
    expect(() => saved!.read()).toThrow("poisoned");
    expect(() => raw.lv_pow(2n, 3)).toThrow("poisoned");
    expect(() => runtime.shutdown()).toThrow("poisoned");
    decoder.cancel();
    decoder.cancel();
    await Promise.resolve();
  }
});
