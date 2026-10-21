import { expect, test } from "bun:test";
import { LvglRuntime, LV_EVENT_DELETE, LV_RESULT_OK } from "../bindings/typescript/src/index.ts";
import { createWasiImports } from "../bindings/typescript/src/wasi.ts";

async function setup() {
  const runtime = await LvglRuntime.load(await Bun.file("target/wasm/liblvgl.wasm").arrayBuffer());
  const display = runtime.createDisplay(160, 120);
  const pointer = runtime.createPointer(display);
  const screen = runtime.screen(display);
  const button = runtime.createButton(screen);
  button.setSize(80, 40);
  button.setPosition(20, 20);
  const label = runtime.createLabel(screen);
  label.setPosition(0, 100);
  const other = runtime.createButton(screen);
  other.setSize(20, 20);
  other.setPosition(120, 80);
  const api = runtime.unsafe;
  const saved = { pow: api.lv_pow, alloc: api.lvw_alloc, free: api.lvw_free };
  const scratch = saved.alloc(4);
  const clicked = runtime.clickedEvent;
  for (let index = 0; index < 5; index++) runtime.step(50);
  return { runtime, display, pointer, button, label, other, api, saved, scratch, clicked };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

function click({ runtime, pointer }: Fixture): void {
  pointer.push(40, 35, true);
  runtime.step(50);
  pointer.push(40, 35, false);
  runtime.step(50);
}

function thrown(call: () => unknown): unknown {
  let didThrow = false;
  let value: unknown;
  try {
    call();
  } catch (error) {
    didThrow = true;
    value = error;
  }
  expect(didThrow).toBe(true);
  return value;
}

function unavailable(f: Fixture, state: "closing" | "poisoned" | "closed"): void {
  expect(() => f.runtime.unsafe).toThrow(state);
  const entries = [
    () => f.saved.pow(2n, 3),
    () => f.saved.alloc(4),
    () => f.saved.free(f.scratch),
    () => f.api.memory,
    () => f.runtime.clickedEvent,
    () => f.runtime.deleteEvent,
    () => f.runtime.createDisplay(80, 60),
    () => f.runtime.setText(f.label, "blocked"),
    () => f.runtime.readFrame(f.display),
    () => f.runtime.onEvent(f.other, f.clicked, () => {}),
    () => f.runtime.step(1),
    () => f.runtime.shutdown(),
  ];
  for (const entry of entries) expect(entry).toThrow();
}

for (const origin of ["raw event", "DELETE", "step", "shutdown", "Wasm trap"] as const) {
  test(`guest failure from ${origin} disables runtime access`, async () => {
    const f = await setup();
    // Undefined is a valid thrown value, so failure state cannot depend on a truthy error.
    const failure = origin === "step" ? undefined : new Error(`${origin} callback failure`);
    let calls = 0;
    f.button.on(origin === "DELETE" || origin === "shutdown" ? LV_EVENT_DELETE : f.clicked, () => {
      calls++;
      throw failure;
    });
    const trigger = {
      "raw event": () => f.api.lv_obj_send_event(f.button.handle, f.clicked, 0),
      DELETE: () => f.api.lv_obj_delete(f.button.handle),
      step: () => click(f),
      shutdown: () => f.runtime.shutdown(),
      "Wasm trap": () => f.api.lv_color_to_int(f.api.memory.buffer.byteLength - 1),
    }[origin];
    const error = thrown(trigger);
    if (origin === "Wasm trap") expect(error).toBeInstanceOf(WebAssembly.RuntimeError);
    else expect(error).toBe(failure);
    expect(calls).toBe(origin === "Wasm trap" ? 0 : 1);
    unavailable(f, "poisoned");
  });
}

test("callbacks can update UI and catch lifecycle preconditions without poisoning the caller", async () => {
  const f = await setup();
  let calls = 0;
  f.button.on(f.clicked, () => {
    calls++;
    f.runtime.setText(f.label, "updated");
    f.api.lv_obj_set_width(f.other.handle, 24);
    expect(() => f.runtime.step(1)).toThrow("not reentrant");
    expect(() => f.runtime.shutdown()).toThrow("not reentrant");
  });
  expect(f.api.lv_obj_send_event(f.button.handle, f.clicked, 0)).toBe(LV_RESULT_OK);
  click(f);
  expect(calls).toBe(2);
  const text = f.api.lv_label_get_text(f.label.handle);
  expect(new TextDecoder().decode(new Uint8Array(f.api.memory.buffer, text, 7))).toBe("updated");
  expect(f.saved.pow(2n, 3)).toBe(8n);
  f.saved.free(f.scratch);
  f.runtime.shutdown();
});

test("catching a nested guest failure cannot let the outer event resume successfully", async () => {
  const f = await setup();
  const failure = new Error("nested callback failure");
  let caught = false;
  f.other.on(f.clicked, () => { throw failure; });
  f.button.on(f.clicked, () => {
    expect(thrown(() => f.api.lv_obj_send_event(f.other.handle, f.clicked, 0))).toBe(failure);
    caught = true;
  });
  expect(thrown(() => f.api.lv_obj_send_event(f.button.handle, f.clicked, 0))).toBe(failure);
  expect(caught).toBe(true);
  unavailable(f, "poisoned");
});

test("shutdown delivers host-only DELETE notifications while guest access is closed", async () => {
  const f = await setup();
  const deleted: number[] = [];
  f.button.on(LV_EVENT_DELETE, (code) => {
    deleted.push(code);
    expect(code).toBe(LV_EVENT_DELETE);
    unavailable(f, "closing");
  });
  f.saved.free(f.scratch);
  f.runtime.shutdown();
  expect(deleted).toEqual([LV_EVENT_DELETE]);
  unavailable(f, "closed");
});

test("the bridge rejects step and shutdown inside raw event and DELETE callbacks", async () => {
  interface Bridge {
    memory: WebAssembly.Memory;
    _initialize(): void;
    lvw_init(): number;
    lvw_shutdown(): number;
    lvw_alloc(bytes: number): number;
    lvw_free(pointer: number): void;
    lvw_step(milliseconds: number, result: number): number;
    lvw_display_create(width: number, height: number, format: number): number;
    lv_display_get_screen_active(display: number): number;
    lv_button_create(parent: number): number;
    lvw_event_clicked(): number;
    lvw_event_add(object: number, code: number, callback: number): number;
    lv_obj_send_event(object: number, code: number, parameter: number): number;
  }
  let core: Bridge;
  let result: number;
  const notifications: number[] = [];
  const { instance } = await WebAssembly.instantiate(
    await Bun.file("target/wasm/liblvgl.wasm").arrayBuffer(),
    {
      lvw: {
        timer() {},
        timer_release() {},
        anim_exec() {},
        anim_query() { return 0; },
        anim_notify() {},
        anim_release() {},
        observer() {},
        observer_release() {},
        decoder_info() { return 0; }, decoder_open() { return 0; }, decoder_area() { return 0; },
        decoder_close() {}, decoder_release() {},
        event(id: number) {
          notifications.push(id);
          expect(core.lvw_step(1, result)).toBe(-1);
          expect(core.lvw_shutdown()).toBe(-1);
        },
      },
      wasi_snapshot_preview1: createWasiImports(() => core?.memory),
    },
  );
  core = instance.exports as unknown as Bridge;
  core._initialize();
  expect(core.lvw_init()).toBe(0);
  const display = core.lvw_display_create(80, 60, 1);
  expect(display).not.toBe(0);
  const button = core.lv_button_create(core.lv_display_get_screen_active(display));
  // lvw_step_result_t starts with its byte size and bridge ABI version.
  result = core.lvw_alloc(16);
  expect(result).not.toBe(0);
  const view = new DataView(core.memory.buffer);
  view.setUint32(result, 16, true);
  view.setUint32(result + 4, 1, true);
  const clicked = core.lvw_event_clicked();
  expect(core.lvw_event_add(button, clicked, 1)).toBe(0);
  expect(core.lvw_event_add(button, LV_EVENT_DELETE, 2)).toBe(0);
  expect(core.lv_obj_send_event(button, clicked, 0)).toBe(LV_RESULT_OK);
  expect(notifications).toEqual([1]);
  expect(core.lvw_step(1, result)).toBe(0);
  expect(core.lvw_shutdown()).toBe(0);
  expect(notifications).toEqual([1, 2]);
  core.lvw_free(result);
});
