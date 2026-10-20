import { expect, test } from "bun:test";
import {
  LV_AREA_T_FIELDS, LV_AREA_T_SIZE, LV_DRAW_DSC_BASE_T_FIELDS,
  LV_DRAW_FILL_DSC_T_FIELDS, LV_DRAW_RECT_DSC_T_FIELDS, LV_DRAW_RECT_DSC_T_SIZE,
  LV_DRAW_TASK_TYPE_FILL, LV_EVENT_CLICKED, LV_EVENT_DELETE,
  LV_EVENT_DRAW_MAIN_END, LV_EVENT_DRAW_TASK_ADDED, LV_EVENT_VALUE_CHANGED,
  LV_PART_MAIN, LvglRuntime, type Frame,
} from "../bindings/typescript/src/index.ts";

async function load(): Promise<LvglRuntime> {
  return LvglRuntime.load(await Bun.file("target/wasm/liblvgl.wasm").arrayBuffer());
}

function offset(fields: readonly { name: string | null; bit_offset: number; bit_width: number | null }[],
                name: string): number {
  const field = fields.find((item) => item.name === name)!;
  expect(field.bit_width).toBeNull();
  return field.bit_offset / 8;
}

function pixel(frame: Frame, x: number, y: number): number[] {
  const start = (y * frame.width + x) * 4;
  return [...frame.rgba.subarray(start, start + 4)];
}

test("native layer events submit drawing commands that appear in the framebuffer", async () => {
  const runtime = await load();
  const raw = runtime.unsafe;
  const display = runtime.createDisplay(64, 48);
  const screen = runtime.screen(display);
  const rectangle = raw.lvw_alloc(LV_DRAW_RECT_DSC_T_SIZE);
  const area = raw.lvw_alloc(LV_AREA_T_SIZE);
  raw.lv_draw_rect_dsc_init(rectangle);
  raw.lv_color_hex(rectangle + offset(LV_DRAW_RECT_DSC_T_FIELDS, "bg_color"), 0x123456);
  for (const [name, value] of [["x1", 12], ["y1", 10], ["x2", 27], ["y2", 25]] as const) {
    new DataView(raw.memory.buffer).setInt32(area + offset(LV_AREA_T_FIELDS, name), value, true);
  }
  let calls = 0;
  const stop = screen.on(LV_EVENT_DRAW_MAIN_END, (code) => {
    const event = runtime.eventPointer();
    expect(raw.lv_event_get_code(event)).toBe(code);
    expect(raw.lv_event_get_current_target_obj(event)).toBe(screen.handle);
    const layer = raw.lv_event_get_layer(event);
    expect(layer).not.toBe(0);
    expect(raw.lv_event_get_param(event)).toBe(layer);
    expect(() => runtime.step(1)).toThrow("not reentrant");
    expect(() => runtime.shutdown()).toThrow("not reentrant");
    raw.lv_draw_rect(layer, rectangle, area);
    calls++;
  });
  runtime.step(33);
  const frame = runtime.readFrame(display);
  expect(calls).toBeGreaterThan(0);
  expect(frame.frameId).toBeGreaterThan(0);
  expect(pixel(frame, 16, 16)).toEqual([0x12, 0x34, 0x56, 255]);
  expect(pixel(frame, 2, 2)).not.toEqual([0x12, 0x34, 0x56, 255]);
  expect(() => runtime.eventPointer()).toThrow("no active");
  stop();
  raw.lvw_free(rectangle);
  raw.lvw_free(area);
  runtime.shutdown();
});

test("draw task events modify the actual fill descriptor before software rendering", async () => {
  const runtime = await load();
  const raw = runtime.unsafe;
  const display = runtime.createDisplay(64, 48);
  const screen = runtime.screen(display);
  const objectOffset = offset(LV_DRAW_DSC_BASE_T_FIELDS, "obj");
  const partOffset = offset(LV_DRAW_DSC_BASE_T_FIELDS, "part");
  const layerOffset = offset(LV_DRAW_DSC_BASE_T_FIELDS, "layer");
  const colorOffset = offset(LV_DRAW_FILL_DSC_T_FIELDS, "color");
  raw.lv_obj_set_send_draw_task_events(screen.handle, 1);
  let fills = 0;
  screen.on(LV_EVENT_DRAW_TASK_ADDED, () => {
    const event = runtime.eventPointer();
    const task = raw.lv_event_get_draw_task(event);
    expect(task).not.toBe(0);
    expect(raw.lv_event_get_param(event)).toBe(task);
    if (raw.lv_draw_task_get_type(task) !== LV_DRAW_TASK_TYPE_FILL) return;
    const descriptor = raw.lv_draw_task_get_draw_dsc(task);
    const view = new DataView(raw.memory.buffer);
    expect(view.getUint32(descriptor + objectOffset, true)).toBe(screen.handle);
    expect(view.getUint32(descriptor + partOffset, true)).toBe(LV_PART_MAIN);
    expect(view.getUint32(descriptor + layerOffset, true)).not.toBe(0);
    const fill = raw.lv_draw_task_get_fill_dsc(task);
    expect(fill).not.toBe(0);
    raw.lv_color_hex(fill + colorOffset, 0x22aa66);
    fills++;
  });
  runtime.step(33);
  expect(fills).toBeGreaterThan(0);
  const frame = runtime.readFrame(display);
  expect(pixel(frame, 16, 16)).toEqual([0x22, 0xaa, 0x66, 255]);
  expect(pixel(frame, 48, 32)).toEqual([0x22, 0xaa, 0x66, 255]);
  runtime.shutdown();
});

test("nested event parameters and propagation stay synchronous and restore the outer event", async () => {
  const runtime = await load();
  const other = await load();
  const raw = runtime.unsafe;
  const display = runtime.createDisplay(64, 48);
  const outerObject = runtime.createButton(runtime.screen(display));
  const innerObject = runtime.createButton(runtime.screen(display));
  const parameters = raw.lvw_alloc(8);
  let outerPointer = 0;
  let skipped = 0;
  const order: string[] = [];
  expect(() => runtime.eventPointer()).toThrow("no active");
  expect(raw.lv_pow(2n, 3)).toBe(8n);
  innerObject.on(LV_EVENT_VALUE_CHANGED, (code) => {
    order.push("inner");
    const event = runtime.eventPointer();
    expect(event).not.toBe(outerPointer);
    expect(raw.lv_event_get_code(event)).toBe(code);
    expect(raw.lv_event_get_target_obj(event)).toBe(innerObject.handle);
    expect(raw.lv_event_get_current_target_obj(event)).toBe(innerObject.handle);
    expect(raw.lv_event_get_param(event)).toBe(parameters + 4);
    new DataView(raw.memory.buffer).setUint32(raw.lv_event_get_param(event), 41, true);
    raw.lv_event_stop_processing(event);
  });
  innerObject.on(LV_EVENT_VALUE_CHANGED, () => { skipped++; });
  outerObject.on(LV_EVENT_CLICKED, () => {
    order.push("outer");
    outerPointer = runtime.eventPointer();
    expect(raw.lv_event_get_param(outerPointer)).toBe(parameters);
    expect(raw.lv_event_get_current_target_obj(outerPointer)).toBe(outerObject.handle);
    expect(() => other.eventPointer()).toThrow("no active");
    raw.lv_obj_send_event(innerObject.handle, LV_EVENT_VALUE_CHANGED, parameters + 4);
    expect(runtime.eventPointer()).toBe(outerPointer);
    expect(raw.lv_event_get_param(runtime.eventPointer())).toBe(parameters);
    expect(new DataView(raw.memory.buffer).getUint32(parameters + 4, true)).toBe(41);
    order.push("restored");
  });
  raw.lv_obj_send_event(outerObject.handle, LV_EVENT_CLICKED, parameters);
  expect(order).toEqual(["outer", "inner", "restored"]);
  expect(skipped).toBe(0);
  expect(() => runtime.eventPointer()).toThrow("no active");
  let closing = 0;
  outerObject.on(LV_EVENT_DELETE, () => {
    closing++;
    expect(() => runtime.eventPointer()).toThrow("closing");
  });
  raw.lvw_free(parameters);
  runtime.shutdown();
  expect(closing).toBe(1);
  expect(() => runtime.eventPointer()).toThrow("closed");
  other.shutdown();
});

test("drawing exceptions, caught guest traps and asynchronous event results poison the runtime", async () => {
  for (const failure of ["throw", "caught trap", "thenable"] as const) {
    const runtime = await load();
    const raw = runtime.unsafe;
    const display = runtime.createDisplay(64, 48);
    const screen = runtime.screen(display);
    const marker = new Error("drawing callback failed");
    screen.on(LV_EVENT_DRAW_MAIN_END, () => {
      expect(runtime.eventPointer()).not.toBe(0);
      if (failure === "throw") throw marker;
      if (failure === "caught trap") {
        expect(() => raw.lv_color_to_int(raw.memory.buffer.byteLength - 1)).toThrow(WebAssembly.RuntimeError);
      } else {
        return Promise.reject(marker);
      }
    });
    let escaped: unknown;
    try { runtime.step(33); } catch (error) { escaped = error; }
    expect(escaped).toBeDefined();
    if (failure === "throw") expect(escaped).toBe(marker);
    if (failure === "thenable") expect(String(escaped)).toContain("must finish synchronously");
    expect(() => runtime.eventPointer()).toThrow("poisoned");
    expect(() => raw.lv_pow(2n, 3)).toThrow("poisoned");
    expect(() => runtime.shutdown()).toThrow("poisoned");
    await Promise.resolve();
  }
});
