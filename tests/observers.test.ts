import { expect, test } from "bun:test";
import type { LvglRuntime, Observer } from "../bindings/typescript/src/index.ts";

const sdk = await import(Bun.env.LVW_TEST_TS_RUNTIME ?? "../bindings/typescript/src/index.ts") as
  typeof import("../bindings/typescript/src/index.ts") & {
    LV_OBSERVER_T_FIELDS?: readonly { name: string | null; bit_offset: number; bit_width: number | null }[];
  };
const {
  LV_EVENT_DELETE, LV_EVENT_VALUE_CHANGED, LV_STATE_CHECKED,
  LV_SUBJECT_T_SIZE, LV_SUBJECT_TYPE_INT, LV_SUBJECT_TYPE_POINTER,
} = sdk;
const legacy = Number(sdk.LVGL_VERSION_MINOR) < 2;

function old(runtime: LvglRuntime) {
  return runtime.unsafe as unknown as {
    lv_observer_remove(pointer: number): void;
    lv_subject_remove_all_obj(subject: number, object: number): void;
    lv_button_bind_checked(object: number, subject: number): number;
  };
}

function userData(runtime: LvglRuntime, pointer: number, value?: number): number {
  const raw = runtime.unsafe;
  if (!legacy) {
    const previous = raw.lv_observer_get_user_data(pointer) >>> 0;
    if (value !== undefined) raw.lv_observer_set_user_data(pointer, value);
    return previous;
  }
  const field = sdk.LV_OBSERVER_T_FIELDS!.find((field) => field.name === "user_data")!;
  expect(field.bit_width).toBeNull();
  expect(field.bit_offset % 8).toBe(0);
  const view = new DataView(raw.memory.buffer);
  const offset = pointer + field.bit_offset / 8;
  const previous = view.getUint32(offset, true);
  if (value !== undefined) view.setUint32(offset, value, true);
  return previous;
}

function unbind(runtime: LvglRuntime, object: number, source: number): void {
  if (legacy) old(runtime).lv_subject_remove_all_obj(source, object);
  else runtime.unsafe.lv_obj_remove_from_subject(object, source);
}

async function load(): Promise<LvglRuntime> {
  return sdk.LvglRuntime.load(await Bun.file(Bun.env.LVW_TEST_CORE ?? "target/wasm/liblvgl.wasm").arrayBuffer());
}

function subject(runtime: LvglRuntime, type = LV_SUBJECT_TYPE_INT): number {
  const raw = runtime.unsafe;
  const pointer = legacy ? raw.lvw_alloc(LV_SUBJECT_T_SIZE) : raw.lv_subject_create(type);
  expect(pointer).not.toBe(0);
  if (legacy) {
    if (type === LV_SUBJECT_TYPE_INT) raw.lv_subject_init_int(pointer, 0);
    else raw.lv_subject_init_pointer(pointer, 0);
  }
  return pointer;
}

test("observers synchronously expose native values, target and mutable user data in their own instance", async () => {
  const runtime = await load();
  const other = await load();
  const raw = runtime.unsafe;
  const source = subject(runtime);
  const otherSource = subject(other);
  raw.lv_subject_set_int(source, 7);
  const display = runtime.createDisplay(80, 60);
  const label = runtime.createLabel(runtime.screen(display));
  const values: number[] = [];
  let otherCalls = 0;
  other.observe(otherSource, () => { otherCalls++; });
  const observer = runtime.observeTarget(source, 0xf1234567, (current, notified) => {
    expect(notified).toBe(source);
    expect(raw.lv_observer_get_target(current.handle) >>> 0).toBe(0xf1234567);
    expect(userData(runtime, current.handle, 0x87654321)).toBe(values.length ? 0x87654321 : 0xabcdef98);
    const value = raw.lv_subject_get_int(notified);
    values.push(value);
    runtime.setText(label, String(value));
    expect(() => runtime.step(1)).toThrow("not reentrant");
    expect(() => runtime.shutdown()).toThrow("not reentrant");
  }, 0xabcdef98);
  expect(values).toEqual([7]);
  raw.lv_subject_set_int(source, 7);
  expect(values).toEqual(legacy ? [7, 7] : [7]);
  raw.lv_subject_set_int(source, 8);
  expect(values).toEqual(legacy ? [7, 7, 8] : [7, 8]);
  expect(raw.lv_subject_get_previous_int(source)).toBe(7);
  expect([...new Uint8Array(raw.memory.buffer, raw.lv_label_get_text(label.handle), 2)]).toEqual([56, 0]);
  expect(otherCalls).toBe(1);
  expect(() => other.cancelObserver(observer)).toThrow("invalid");

  const pointerSource = subject(runtime, LV_SUBJECT_TYPE_POINTER);
  let pointerCalls = 0;
  runtime.observe(pointerSource, (current, notified) => {
    expect(raw.lv_observer_get_target(current.handle)).toBe(0);
    expect(raw.lv_subject_get_pointer(notified)).toBe(0);
    pointerCalls++;
  });
  raw.lv_subject_set_pointer(pointerSource, 0);
  raw.lv_subject_set_pointer(pointerSource, 0);
  expect(pointerCalls).toBe(3);
  runtime.shutdown();
  other.shutdown();
});

test("initial callbacks can cancel themselves and nest registrations and different subject notifications", async () => {
  const runtime = await load();
  const raw = runtime.unsafe;
  const source = subject(runtime);
  let initialCalls = 0;
  const removed = runtime.observe(source, (current) => {
    initialCalls++;
    expect(current.handle).not.toBe(0);
    current.cancel();
    expect(() => current.handle).toThrow("invalid");
  });
  expect(initialCalls).toBe(1);
  expect(() => removed.handle).toThrow("invalid");
  removed.cancel();
  raw.lv_subject_set_int(source, 1);
  expect(initialCalls).toBe(1);

  const first = subject(runtime);
  const second = subject(runtime);
  const order: string[] = [];
  let nested: Observer | undefined;
  runtime.observe(second, (_current, notified) => {
    order.push(`b:${raw.lv_subject_get_int(notified)}`);
  });
  const outer = runtime.observe(first, (_current, notified) => {
    const value = raw.lv_subject_get_int(notified);
    order.push(`a:${value}`);
    if (!nested) {
      nested = runtime.observe(first, (_nested, same) => {
        order.push(`nested:${raw.lv_subject_get_int(same)}`);
      });
    }
    if (value !== 0) raw.lv_subject_set_int(second, value);
  });
  expect(order).toEqual(["b:0", "a:0", "nested:0"]);
  raw.lv_subject_set_int(first, 1);
  expect(order).toEqual(["b:0", "a:0", "nested:0", "a:1", "b:1", "nested:1"]);
  expect(outer.handle).not.toBe(nested!.handle);
  runtime.shutdown();
});

test("notifications can remove observers and stale handles cannot affect replacement subscriptions", async () => {
  const runtime = await load();
  const raw = runtime.unsafe;
  const source = subject(runtime);
  const ownValues: number[] = [];
  const victimValues: number[] = [];
  const successorValues: number[] = [];
  let victim: Observer;
  let successor: Observer | undefined;
  const own = runtime.observe(source, (current, notified) => {
    const value = raw.lv_subject_get_int(notified);
    ownValues.push(value);
    if (value === 0) return;
    victim.cancel();
    current.cancel();
    successor = runtime.observe(source, (_next, nextSubject) => {
      successorValues.push(raw.lv_subject_get_int(nextSubject));
    });
  });
  victim = runtime.observe(source, (_current, notified) => {
    victimValues.push(raw.lv_subject_get_int(notified));
  });
  raw.lv_subject_set_int(source, 1);
  expect(ownValues).toEqual([0, 1]);
  expect(victimValues).toEqual([0]);
  expect(() => own.handle).toThrow("invalid");
  expect(() => victim.handle).toThrow("invalid");
  expect(successor).toBeDefined();
  const before = successorValues.length;
  own.cancel();
  victim.cancel();
  raw.lv_subject_set_int(source, 2);
  expect(successorValues.length).toBe(before + 1);
  expect(successorValues.at(-1)).toBe(2);
  const rawDeleted = runtime.observe(source, () => {});
  if (legacy) old(runtime).lv_observer_remove(rawDeleted.handle);
  else raw.lv_observer_delete(rawDeleted.handle);
  expect(() => rawDeleted.handle).toThrow("invalid");
  rawDeleted.cancel();
  if (legacy) {
    successor!.cancel();
    raw.lvw_free(source);
  } else raw.lv_subject_delete(source);
  expect(() => successor!.handle).toThrow("invalid");
  successor!.cancel();
  runtime.shutdown();
});

test("object-bound cancellation preserves existing two-way bindings and validates object ownership", async () => {
  const runtime = await load();
  const other = await load();
  const raw = runtime.unsafe;
  const source = subject(runtime);
  const display = runtime.createDisplay(80, 60);
  const object = runtime.createButton(runtime.screen(display));
  expect(legacy ? old(runtime).lv_button_bind_checked(object.handle, source)
    : raw.lv_obj_bind_checked(object.handle, source)).not.toBe(0);
  const values: number[] = [];
  const observer = runtime.observeObject(source, object, (current, notified) => {
    expect(raw.lv_observer_get_target_obj(current.handle)).toBe(object.handle);
    values.push(raw.lv_subject_get_int(notified));
  });
  const count = raw.lv_obj_get_event_count(object.handle);
  const handle = observer.handle;
  expect(() => observer.cancel()).toThrow("(-3)");
  expect(observer.handle).toBe(handle);
  expect(raw.lv_obj_get_event_count(object.handle)).toBe(count);
  raw.lv_obj_add_state(object.handle, LV_STATE_CHECKED);
  raw.lv_obj_send_event(object.handle, LV_EVENT_VALUE_CHANGED, 0);
  expect(raw.lv_subject_get_int(source)).toBe(1);
  raw.lv_subject_set_int(source, 0);
  expect(raw.lv_obj_has_state(object.handle, LV_STATE_CHECKED)).toBe(0);
  expect(values).toEqual([0, 1, 0]);

  const otherSource = subject(other);
  expect(() => other.observeObject(otherSource, object, () => {})).toThrow("invalid");
  unbind(runtime, object.handle, source);
  expect(() => observer.handle).toThrow("invalid");
  observer.cancel();
  object.delete();
  expect(() => runtime.observeObject(source, object, () => {})).toThrow("invalid");
  runtime.shutdown();
  other.shutdown();
});

test("native object, parent, display and subject cleanup invalidate every associated observer", async () => {
  const deletions = legacy ? ["object", "parent", "display"] : ["object", "parent", "display", "subject", "deinit"];
  for (const deletion of deletions) {
    const runtime = await load();
    const raw = runtime.unsafe;
    const source = deletion === "deinit" ? raw.lvw_alloc(LV_SUBJECT_T_SIZE) : subject(runtime);
    if (deletion === "deinit") raw.lv_subject_init_int(source, 0);
    const display = runtime.createDisplay(80, 60);
    const parent = runtime.createButton(runtime.screen(display));
    const object = runtime.createLabel(parent);
    let calls = 0;
    const first = runtime.observeObject(source, object, () => { calls++; });
    const second = runtime.observeObject(source, object, () => { calls++; });
    const independent = runtime.observe(source, () => { calls++; });
    expect(calls).toBe(3);
    if (deletion === "object") object.delete();
    else if (deletion === "parent") parent.delete();
    else if (deletion === "display") runtime.destroyDisplay(display.handle);
    else if (deletion === "subject") raw.lv_subject_delete(source);
    else raw.lv_subject_deinit(source);
    for (const observer of [first, second]) {
      expect(() => observer.handle).toThrow("invalid");
      observer.cancel();
      observer.cancel();
    }
    if (deletion === "subject" || deletion === "deinit") {
      expect(() => independent.handle).toThrow("invalid");
    } else {
      raw.lv_subject_set_int(source, 1);
      expect(calls).toBe(4);
      independent.cancel();
    }
    if (deletion === "deinit") raw.lvw_free(source);
    runtime.shutdown();
  }
});

test("unbinding one subject preserves other subjects and unrelated events", async () => {
  for (const widget of ["button", "slider"] as const) {
    const runtime = await load();
    const raw = runtime.unsafe;
    const first = subject(runtime);
    const second = subject(runtime);
    const display = runtime.createDisplay(80, 60);
    const screen = runtime.screen(display);
    const object = widget === "button" ? runtime.createButton(screen)
      : new sdk.ObjectRef(runtime, raw.lv_slider_create(screen.handle));
    for (const source of [first, second]) {
      if (widget === "slider") raw.lv_slider_bind_value(object.handle, source);
      else if (legacy) old(runtime).lv_button_bind_checked(object.handle, source);
      else raw.lv_obj_bind_checked(object.handle, source);
    }
    const detached = runtime.observeObject(first, object, () => {});
    let calls = 0;
    const retained = runtime.observeObject(second, object, () => { calls++; });
    let events = 0;
    object.on(LV_EVENT_VALUE_CHANGED, () => { events++; });
    unbind(runtime, object.handle, first);
    expect(() => detached.handle).toThrow("invalid");
    expect(retained.handle).not.toBe(0);
    const before = calls;
    if (widget === "slider") raw.lv_slider_set_value(object.handle, 1, sdk.LV_ANIM_OFF);
    else raw.lv_obj_add_state(object.handle, LV_STATE_CHECKED);
    raw.lv_obj_send_event(object.handle, LV_EVENT_VALUE_CHANGED, 0);
    expect(raw.lv_subject_get_int(first)).toBe(0);
    expect(raw.lv_subject_get_int(second)).toBe(1);
    expect(calls).toBe(before + 1);
    expect(events).toBe(1);
    object.delete();
    expect(() => retained.handle).toThrow("invalid");
    const after = calls;
    raw.lv_subject_set_int(second, 2);
    expect(calls).toBe(after);
    runtime.shutdown();
  }
});

test("object deletion inside the initial notification returns an invalid observer", async () => {
  const runtime = await load();
  const source = subject(runtime);
  const display = runtime.createDisplay(80, 60);
  const object = runtime.createButton(runtime.screen(display));
  const observer = runtime.observeObject(source, object, () => { object.delete(); });
  expect(() => observer.handle).toThrow("invalid");
  observer.cancel();
  runtime.unsafe.lv_subject_set_int(source, 1);
  if (legacy) {
    for (const name of ["lv_subject_create", "lv_subject_delete", "lv_subject_deinit", "lv_observer_get_user_data"]) {
      expect(name in runtime.unsafe).toBe(false);
    }
    runtime.unsafe.lvw_free(source);
  }
  runtime.shutdown();
});

test("shutdown invalidates legacy subjects and observer cancellation remains host-only", async () => {
  const runtime = await load();
  const raw = runtime.unsafe;
  const legacy = raw.lvw_alloc(LV_SUBJECT_T_SIZE);
  raw.lv_subject_init_int(legacy, 42);
  const display = runtime.createDisplay(80, 60);
  const object = runtime.createButton(runtime.screen(display));
  let notifications = 0;
  const ordinary = runtime.observe(legacy, () => { notifications++; });
  const bound = runtime.observeObject(legacy, object, () => { notifications++; });
  let closing = 0;
  object.on(LV_EVENT_DELETE, () => {
    closing++;
    expect(() => ordinary.handle).toThrow("closing");
    expect(() => bound.handle).toThrow("closing");
    ordinary.cancel();
    bound.cancel();
  });
  runtime.shutdown();
  expect(closing).toBe(1);
  expect(notifications).toBe(2);
  for (const observer of [ordinary, bound]) {
    expect(() => observer.handle).toThrow("closed");
    observer.cancel();
    observer.cancel();
  }
});

test("initial and subsequent observer failures permanently poison the shared runtime", async () => {
  for (const timing of ["initial", "update"] as const) {
    for (const failure of ["throw", "caught trap", "thenable"] as const) {
      const runtime = await load();
      const raw = runtime.unsafe;
      const source = subject(runtime);
      const existing = runtime.observe(source, () => {});
      const marker = new Error("observer callback failure");
      let failed: Observer | undefined;
      const register = () => runtime.observe(source, (current, notified) => {
        failed = current;
        if (timing === "update" && raw.lv_subject_get_int(notified) === 0) return;
        if (failure === "throw") throw marker;
        if (failure === "caught trap") {
          expect(() => raw.lv_color_to_int(raw.memory.buffer.byteLength - 1)).toThrow(WebAssembly.RuntimeError);
        } else {
          return Promise.reject(marker);
        }
      });
      let escaped: unknown;
      try {
        register();
        if (timing === "update") raw.lv_subject_set_int(source, 1);
      } catch (error) {
        escaped = error;
      }
      expect(escaped).toBeDefined();
      if (failure === "throw") expect(escaped).toBe(marker);
      expect(failed).toBeDefined();
      expect(() => failed!.handle).toThrow("poisoned");
      expect(() => existing.handle).toThrow("poisoned");
      failed!.cancel();
      existing.cancel();
      expect(() => raw.lv_pow(2n, 3)).toThrow("poisoned");
      expect(() => runtime.observe(source, () => {})).toThrow("poisoned");
      expect(() => runtime.shutdown()).toThrow("poisoned");
      await Promise.resolve();
    }
  }
});
