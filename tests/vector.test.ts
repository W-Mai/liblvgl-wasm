import { expect, test } from "bun:test";
import type { Frame, UnsafeLvgl } from "../bindings/typescript/src/index.ts";
const sdk: typeof import("../bindings/typescript/src/index.ts") = await import(
  Bun.env.LVW_TEST_TS_RUNTIME ?? "../bindings/typescript/src/index.ts");
const {
  LV_COLOR_T_SIZE, LV_EVENT_DRAW_MAIN_END, LV_FPOINT_T_FIELDS, LV_FPOINT_T_SIZE,
  LV_GRAD_STOP_T_FIELDS, LV_GRAD_STOP_T_SIZE, LV_MATRIX_T_SIZE, LV_OPA_COVER,
  LV_PART_MAIN, LV_POINT_PRECISE_T_FIELDS, LV_POINT_PRECISE_T_SIZE,
  LV_VECTOR_FILL_EVENODD, LV_VECTOR_FILL_NONZERO, LV_VECTOR_PATH_QUALITY_HIGH,
  LvglRuntime,
} = sdk;
import fixture from "./fixtures/vector/expected.json";

const minor = Number(sdk.LVGL_VERSION_MINOR);
const legacy = [0, 1].includes(minor);
type Raw = UnsafeLvgl;
type Sample = { color: number[]; opacity: number; coverage: number };

function vector(raw: Raw, method: string, ...args: number[]): number {
  const name = `${legacy ? "lv_vector_dsc_" : "lv_draw_vector_dsc_"}${method}`;
  return (raw as unknown as Record<string, (...args: number[]) => number>)[name]!(...args);
}

function offset(fields: readonly { name: string | null; bit_offset: number; bit_width: number | null }[],
                name: string): number {
  const field = fields.find((item) => item.name === name)!;
  expect(field.bit_width).toBeNull();
  return field.bit_offset / 8;
}

function color(raw: Raw, rgb: number[]): number {
  const result = raw.lvw_alloc(LV_COLOR_T_SIZE);
  raw.lv_color_hex(result, (rgb[0]! << 16) | (rgb[1]! << 8) | rgb[2]!);
  return result;
}

async function load() {
  const runtime = await LvglRuntime.load(await Bun.file(Bun.env.LVW_TEST_CORE ?? "target/wasm/liblvgl.wasm").arrayBuffer());
  const raw = runtime.unsafe;
  const display = runtime.createDisplay(fixture.width, fixture.height);
  const screen = runtime.screen(display);
  const background = color(raw, fixture.background);
  raw.lv_obj_set_style_bg_color(screen.handle, background, LV_PART_MAIN);
  raw.lv_obj_set_style_bg_opa(screen.handle, LV_OPA_COVER, LV_PART_MAIN);
  raw.lvw_free(background);
  return { runtime, raw, display, screen };
}

function fill(raw: Raw, descriptor: number, rgb: number[], opacity: number): void {
  const value = color(raw, rgb);
  vector(raw, "set_fill_color", descriptor, value);
  raw.lvw_free(value);
  vector(raw, "set_fill_opa", descriptor, opacity);
  vector(raw, "set_stroke_opa", descriptor, 0);
}

function rectangle(raw: Raw, path: number, dimensions: number[]): void {
  if (!legacy) {
    raw.lv_vector_path_append_rectangle(path, dimensions[0]!, dimensions[1]!, dimensions[2]!, dimensions[3]!, 0, 0);
    return;
  }
  const area = raw.lvw_alloc(sdk.LV_AREA_T_SIZE);
  const [x, y, w, h] = dimensions;
  const view = new DataView(raw.memory.buffer);
  [x!, y!, x! + w! - 1, y! + h! - 1].forEach((value, index) => {
    expect(Number.isInteger(value)).toBe(true);
    view.setInt32(area + offset(sdk.LV_AREA_T_FIELDS, ["x1", "y1", "x2", "y2"][index]!), value, true);
  });
  (raw as unknown as { lv_vector_path_append_rect(p: number, area: number, rx: number, ry: number): void })
    .lv_vector_path_append_rect(path, area, 0, 0);
  raw.lvw_free(area);
}

function coverage(rect: number[], x: number, y: number): number {
  return Math.max(0, Math.min(x + 1, rect[0]! + rect[2]!) - Math.max(x, rect[0]!)) *
    Math.max(0, Math.min(y + 1, rect[1]! + rect[3]!) - Math.max(y, rect[1]!));
}

function framePixels(frame: Frame, sample: (x: number, y: number) => Sample | undefined,
                     quantization = 1): void {
  expect([frame.width, frame.height]).toEqual([fixture.width, fixture.height]);
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const source = sample(x, y);
      const alpha = source ? source.opacity * source.coverage : 0;
      const tolerance = alpha === 0 ? 0 : quantization;
      const start = (y * frame.width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        let expected = Math.floor(((source?.color[channel] ?? 0) * alpha + fixture.background[channel]! * (255 - alpha)) / 255);
        if (legacy && source && alpha && quantization === 1) {
          // ThorVG 0.11.99 rounds each premultiplication and blend term upward.
          const multiply = (value: number, factor: number) => Math.floor((value * factor + 255) / 256);
          const coverageByte = Math.floor(source.coverage * 255);
          const a = source.coverage === 1 ? source.opacity : multiply(source.opacity, coverageByte);
          const premultiplied = multiply(source.color[channel]!, source.opacity);
          const c = source.coverage === 1 ? premultiplied : multiply(premultiplied, coverageByte);
          expected = c + multiply(fixture.background[channel]!, 255 - a);
        }
        expect(Math.abs(frame.rgba[start + channel]! - expected),
          `vector (${x}, ${y}) channel ${channel}: ${frame.rgba[start + channel]} vs ${expected}`)
          .toBeLessThanOrEqual(tolerance);
      }
      expect(frame.rgba[start + 3]).toBe(255);
    }
  }
}

test("vector tasks retain copied paths and styles after their source descriptors are deleted", async () => {
  const { runtime, raw, display, screen } = await load();
  const stop = screen.on(LV_EVENT_DRAW_MAIN_END, () => {
    const descriptor = vector(raw, "create", raw.lv_event_get_layer(runtime.eventPointer()));
    const path = raw.lv_vector_path_create(LV_VECTOR_PATH_QUALITY_HIGH);
    const rect = fixture.solid.rectangle;
    rectangle(raw, path, [rect.x, rect.y, rect.width, rect.height]);
    fill(raw, descriptor, rect.color, rect.opacity);
    vector(raw, "add_path", descriptor, path);
    raw.lv_vector_path_clear(path);
    const point = raw.lvw_alloc(LV_FPOINT_T_SIZE);
    fixture.solid.triangle.points.forEach((xy, index) => {
      const view = new DataView(raw.memory.buffer);
      view.setFloat32(point + offset(LV_FPOINT_T_FIELDS, "x"), xy[0]!, true);
      view.setFloat32(point + offset(LV_FPOINT_T_FIELDS, "y"), xy[1]!, true);
      if (index === 0) raw.lv_vector_path_move_to(path, point);
      else raw.lv_vector_path_line_to(path, point);
    });
    raw.lvw_free(point);
    raw.lv_vector_path_close(path);
    fill(raw, descriptor, fixture.solid.triangle.color, fixture.solid.triangle.opacity);
    vector(raw, "add_path", descriptor, path);
    raw.lv_vector_path_clear(path);
    raw.lv_vector_path_delete(path);
    fill(raw, descriptor, [0, 0, 0], 0);
    raw.lv_draw_vector(descriptor);
    vector(raw, "delete", descriptor);
  });
  for (let redraw = 0; redraw < 3; redraw++) {
    raw.lv_obj_invalidate(screen.handle);
    runtime.step(33);
    framePixels(runtime.readFrame(display), (x, y) => {
      const rect = fixture.solid.rectangle;
      const area = coverage([rect.x, rect.y, rect.width, rect.height], x, y);
      if (area) return { ...rect, opacity: Math.floor(255 * rect.opacity / 256), coverage: area };
      const triangle = fixture.solid.triangle;
      const sx = x - triangle.points[0]![0]!;
      const sy = y - triangle.points[0]![1]!;
      const diagonal = triangle.points[1]![0]! - triangle.points[0]![0]! - 1;
      if (sx < 0 || sy < 0 || sx + sy > diagonal) return;
      return { ...triangle, opacity: Math.floor(255 * triangle.opacity / 256),
        coverage: sx + sy === diagonal ? 0.5 : 1 };
    });
  }
  stop();
  raw.lv_obj_invalidate(screen.handle);
  runtime.step(33);
  framePixels(runtime.readFrame(display), () => undefined);
  runtime.shutdown();
});

test("vector fill rules and fractional matrix scales preserve nested path geometry", async () => {
  const { runtime, raw, display, screen } = await load();
  const shape = fixture.fill;
  screen.on(LV_EVENT_DRAW_MAIN_END, () => {
    const descriptor = vector(raw, "create", raw.lv_event_get_layer(runtime.eventPointer()));
    const path = raw.lv_vector_path_create(LV_VECTOR_PATH_QUALITY_HIGH);
    rectangle(raw, path, shape.outer);
    rectangle(raw, path, shape.inner);
    fill(raw, descriptor, shape.color, shape.opacity);
    shape.translations.forEach((translation, index) => {
      vector(raw, "identity", descriptor);
      vector(raw, "translate", descriptor, translation[0]!, translation[1]!);
      vector(raw, "scale", descriptor, shape.scale[0]!, shape.scale[1]!);
      vector(raw, "set_fill_rule", descriptor, index === 0 ? LV_VECTOR_FILL_NONZERO : LV_VECTOR_FILL_EVENODD);
      vector(raw, "add_path", descriptor, path);
    });
    raw.lv_vector_path_delete(path);
    raw.lv_draw_vector(descriptor);
    vector(raw, "delete", descriptor);
  });
  for (let redraw = 0; redraw < 2; redraw++) {
    raw.lv_obj_invalidate(screen.handle);
    runtime.step(33);
    framePixels(runtime.readFrame(display), (x, y) => {
      for (const [index, translation] of shape.translations.entries()) {
        const transform = (rect: number[]) => [rect[0]! * shape.scale[0]! + translation[0]!,
          rect[1]! * shape.scale[1]! + translation[1]!, rect[2]! * shape.scale[0]!, rect[3]! * shape.scale[1]!];
        const area = coverage(transform(shape.outer), x, y) - (index === 1 ? coverage(transform(shape.inner), x, y) : 0);
        if (area) return { color: shape.color, opacity: Math.floor(255 * shape.opacity / 256), coverage: area };
      }
    });
  }
  runtime.shutdown();
});

test("linear vector gradients interpolate color and alpha across the actual framebuffer", async () => {
  const { runtime, raw, display, screen } = await load();
  const gradient = fixture.gradient;
  screen.on(LV_EVENT_DRAW_MAIN_END, () => {
    const descriptor = vector(raw, "create", raw.lv_event_get_layer(runtime.eventPointer()));
    const path = raw.lv_vector_path_create(LV_VECTOR_PATH_QUALITY_HIGH);
    rectangle(raw, path, gradient.rectangle);
    vector(raw, "set_stroke_opa", descriptor, 0);
    const old = sdk as unknown as { LV_GRADIENT_STOP_T_SIZE: number; LV_GRADIENT_STOP_T_FIELDS: typeof LV_GRAD_STOP_T_FIELDS };
    const stopSize = legacy ? old.LV_GRADIENT_STOP_T_SIZE : LV_GRAD_STOP_T_SIZE;
    const fields = legacy ? old.LV_GRADIENT_STOP_T_FIELDS : LV_GRAD_STOP_T_FIELDS;
    const bytes = legacy ? sdk.LV_GRAD_DSC_T_SIZE : stopSize * gradient.stops.length;
    const storage = raw.lvw_alloc(bytes);
    new Uint8Array(raw.memory.buffer, storage, bytes).fill(0);
    const stops = storage + (legacy ? offset(sdk.LV_GRAD_DSC_T_FIELDS, "stops") : 0);
    gradient.stops.forEach((stop, index) => {
      const address = stops + index * stopSize;
      raw.lv_color_hex(address + offset(fields, "color"), (stop.color[0]! << 16) | (stop.color[1]! << 8) | stop.color[2]!);
      const view = new DataView(raw.memory.buffer);
      view.setUint8(address + offset(fields, "opa"), stop.opacity);
      view.setUint8(address + offset(fields, "frac"), stop.fraction);
    });
    if (legacy) {
      const view = new DataView(raw.memory.buffer);
      view.setUint8(storage + offset(sdk.LV_GRAD_DSC_T_FIELDS, "stops_count"), gradient.stops.length);
      const direction = sdk.LV_GRAD_DSC_T_FIELDS.find((field) => field.name === "dir")!;
      expect(direction.bit_width).toBe(3);
      view.setUint8(storage + Math.floor(direction.bit_offset / 8), sdk.LV_GRAD_DIR_HOR << (direction.bit_offset % 8));
      vector(raw, "set_fill_linear_gradient", descriptor, storage, sdk.LV_VECTOR_GRADIENT_SPREAD_PAD);
    } else {
      vector(raw, "set_fill_linear_gradient", descriptor, gradient.start[0]!, gradient.start[1]!, gradient.end[0]!, gradient.end[1]!);
      vector(raw, "set_fill_gradient_color_stops", descriptor, stops, gradient.stops.length);
    }
    new Uint8Array(raw.memory.buffer, storage, bytes).fill(0);
    raw.lvw_free(storage);
    vector(raw, "add_path", descriptor, path);
    raw.lv_vector_path_delete(path);
    raw.lv_draw_vector(descriptor);
    vector(raw, "delete", descriptor);
  });
  for (let redraw = 0; redraw < 2; redraw++) {
    raw.lv_obj_invalidate(screen.handle);
    runtime.step(33);
    framePixels(runtime.readFrame(display), (x, y) => {
      const area = coverage(gradient.rectangle, x, y);
      if (!area) return;
      const t = (x + 0.5 - gradient.start[0]!) / (gradient.end[0]! - gradient.start[0]!);
      const first = gradient.stops[0]!;
      const last = gradient.stops[1]!;
      return { color: first.color.map((value, channel) => value * (1 - t) + last.color[channel]! * t),
        opacity: first.opacity * (1 - t) + last.opacity * t, coverage: area };
    }, 3);
  }
  runtime.shutdown();
});

test("vector drawing preserves object clipping and translated transparent layers", async () => {
  for (const [opacity, backdropOpacity] of [[255, 0], [128, 0], [128, 96]] as const) {
    const { runtime, raw, display, screen } = await load();
    const object = raw.lv_obj_create(screen.handle);
    raw.lv_obj_remove_style_all(object);
    raw.lv_obj_set_pos(object, 7, 5);
    raw.lv_obj_set_size(object, 24, 20);
    raw.lv_obj_set_style_opa_layered(object, opacity, LV_PART_MAIN);
    const backdrop = color(raw, fixture.fill.color);
    raw.lv_obj_set_style_bg_color(object, backdrop, LV_PART_MAIN);
    raw.lvw_free(backdrop);
    raw.lv_obj_set_style_bg_opa(object, backdropOpacity, LV_PART_MAIN);
    const stop = new sdk.ObjectRef(runtime, object).on(LV_EVENT_DRAW_MAIN_END, () => {
      const descriptor = vector(raw, "create", raw.lv_event_get_layer(runtime.eventPointer()));
      const path = raw.lv_vector_path_create(LV_VECTOR_PATH_QUALITY_HIGH);
      rectangle(raw, path, [0, 0, 50, 40]);
      fill(raw, descriptor, fixture.solid.rectangle.color, 160);
      vector(raw, "add_path", descriptor, path);
      raw.lv_vector_path_delete(path);
      raw.lv_draw_vector(descriptor);
      vector(raw, "delete", descriptor);
    });
    for (let redraw = 0; redraw < 2; redraw++) {
      raw.lv_obj_invalidate(screen.handle);
      runtime.step(33);
      framePixels(runtime.readFrame(display), (x, y) => {
        if (x < 7 || x >= 31 || y < 5 || y >= 25) return;
        const a = 159 / 255;
        const b = backdropOpacity / 255 * (1 - a);
        return { color: fixture.solid.rectangle.color.map((c, i) =>
          (c * a + fixture.fill.color[i]! * b) / (a + b)), opacity: (a + b) * opacity, coverage: 1 };
      }, 3);
    }
    stop();
    raw.lv_obj_delete(object);
    runtime.shutdown();
  }
});

test.skipIf(minor === 0)("point and path transforms agree with the drawing matrix under rotation", async () => {
  const { runtime, raw, display, screen } = await load();
  const sample = fixture.rotation;
  screen.on(LV_EVENT_DRAW_MAIN_END, () => {
    const matrix = raw.lvw_alloc(LV_MATRIX_T_SIZE);
    new Float32Array(raw.memory.buffer, matrix, 9).set(sample.matrix);
    const point = raw.lvw_alloc(LV_FPOINT_T_SIZE);
    sample.point.forEach((value, index) => new DataView(raw.memory.buffer)
      .setFloat32(point + offset(LV_FPOINT_T_FIELDS, ["x", "y"][index]!), value, true));
    raw.lv_matrix_transform_point(matrix, point);
    expect(["x", "y"].map((field) => new DataView(raw.memory.buffer)
      .getFloat32(point + offset(LV_FPOINT_T_FIELDS, field), true))).toEqual(sample.point_expected);
    raw.lvw_free(point);
    const descriptor = vector(raw, "create", raw.lv_event_get_layer(runtime.eventPointer()));
    const path = raw.lv_vector_path_create(LV_VECTOR_PATH_QUALITY_HIGH);
    rectangle(raw, path, sample.rectangle);
    raw.lv_matrix_transform_path(matrix, path);
    fill(raw, descriptor, sample.color, sample.opacity);
    vector(raw, "add_path", descriptor, path);
    raw.lv_vector_path_clear(path);
    rectangle(raw, path, sample.rectangle);
    new Float32Array(raw.memory.buffer, matrix, 9)[2]! += sample.separation;
    vector(raw, "set_transform", descriptor, matrix);
    vector(raw, "add_path", descriptor, path);
    raw.lv_vector_path_delete(path);
    raw.lvw_free(matrix);
    raw.lv_draw_vector(descriptor);
    vector(raw, "delete", descriptor);
  });
  for (let redraw = 0; redraw < 2; redraw++) {
    raw.lv_obj_invalidate(screen.handle);
    runtime.step(33);
    framePixels(runtime.readFrame(display), (x, y) => {
      const covered = coverage(sample.result, x, y) + coverage(sample.result, x - sample.separation, y);
      return covered ? { color: sample.color, opacity: Math.floor(255 * sample.opacity / 256), coverage: covered } : undefined;
    });
  }
  runtime.shutdown();
});

test("FLOAT configuration preserves fractional arc parameters and native matrix operations", async () => {
  const { runtime, raw, screen } = await load();
  const arc = raw.lv_arc_create(screen.handle);
  raw.lv_arc_set_bg_angles(arc, 12.25, 285.75);
  raw.lv_arc_set_angles(arc, 31.5, 172.125);
  expect([raw.lv_arc_get_bg_angle_start(arc), raw.lv_arc_get_bg_angle_end(arc)]).toEqual([12.25, 285.75]);
  expect([raw.lv_arc_get_angle_start(arc), raw.lv_arc_get_angle_end(arc)]).toEqual([31.5, 172.125]);
  const matrix = raw.lvw_alloc(LV_MATRIX_T_SIZE);
  raw.lv_matrix_identity(matrix);
  raw.lv_matrix_translate(matrix, 2.25, -3.5);
  raw.lv_matrix_scale(matrix, 1.5, 0.5);
  if (minor === 0) {
    expect(Array.from(new Float32Array(raw.memory.buffer, matrix, 9))).toEqual([1.5, 0, 2.25, 0, 0.5, -3.5, 0, 0, 1]);
    raw.lvw_free(matrix);
    raw.lv_obj_delete(arc);
    runtime.shutdown();
    return;
  }
  if (!legacy) {
    const point = raw.lvw_alloc(LV_POINT_PRECISE_T_SIZE);
    const result = raw.lvw_alloc(LV_POINT_PRECISE_T_SIZE);
    new DataView(raw.memory.buffer).setFloat32(point + offset(LV_POINT_PRECISE_T_FIELDS, "x"), 4.5, true);
    new DataView(raw.memory.buffer).setFloat32(point + offset(LV_POINT_PRECISE_T_FIELDS, "y"), -1.25, true);
    raw.lv_matrix_transform_precise_point(result, matrix, point);
    const view = new DataView(raw.memory.buffer);
    expect([view.getFloat32(result + offset(LV_POINT_PRECISE_T_FIELDS, "x"), true),
      view.getFloat32(result + offset(LV_POINT_PRECISE_T_FIELDS, "y"), true)]).toEqual([9, -4]);
    raw.lvw_free(result);
    raw.lvw_free(point);
  }
  // The precise-point helper rounds to pixels; the vector-point helper retains fractions.
  const floating = raw.lvw_alloc(LV_FPOINT_T_SIZE);
  new DataView(raw.memory.buffer).setFloat32(floating + offset(LV_FPOINT_T_FIELDS, "x"), 4.5, true);
  new DataView(raw.memory.buffer).setFloat32(floating + offset(LV_FPOINT_T_FIELDS, "y"), -1.25, true);
  raw.lv_matrix_transform_point(matrix, floating);
  const transformed = new DataView(raw.memory.buffer);
  expect([transformed.getFloat32(floating + offset(LV_FPOINT_T_FIELDS, "x"), true),
    transformed.getFloat32(floating + offset(LV_FPOINT_T_FIELDS, "y"), true)]).toEqual([9, -4.125]);
  raw.lvw_free(floating);
  raw.lvw_free(matrix);
  raw.lv_obj_delete(arc);
  runtime.shutdown();
});
