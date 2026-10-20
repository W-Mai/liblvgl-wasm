import { expect, test } from "bun:test";
import {
  LV_ANIM_T_FIELDS, LV_ANIM_T_SIZE, LvglRuntime,
  type Animation,
} from "../bindings/typescript/src/index.ts";

async function load(): Promise<LvglRuntime> {
  return LvglRuntime.load(await Bun.file("target/wasm/liblvgl.wasm").arrayBuffer());
}

function descriptor(runtime: LvglRuntime, early = false, duration = 99, variable = 0): number {
  const raw = runtime.unsafe;
  const pointer = raw.lvw_alloc(LV_ANIM_T_SIZE);
  expect(pointer).not.toBe(0);
  raw.lv_anim_init(pointer);
  raw.lv_anim_set_values(pointer, -10, 30);
  raw.lv_anim_set_duration(pointer, duration);
  raw.lv_anim_set_early_apply(pointer, Number(early));
  raw.lv_anim_set_var(pointer, variable);
  return pointer;
}

function field(runtime: LvglRuntime, pointer: number, name: string): number {
  const layout = LV_ANIM_T_FIELDS.find((item) => item.name === name)!;
  expect(layout.bit_width).toBeNull();
  return new DataView(runtime.unsafe.memory.buffer).getUint32(pointer + layout.bit_offset / 8, true);
}

test("animation queries and exec run synchronously on the native instance clock", async () => {
  const runtime = await load();
  const other = await load();
  const raw = runtime.unsafe;
  const display = runtime.createDisplay(80, 60);
  const label = runtime.createLabel(runtime.screen(display));
  const source = descriptor(runtime, true, 66, 0xabcdef98);
  raw.lv_anim_set_user_data(source, 0xf1234567);
  const order: string[] = [];
  const pointers: number[] = [];
  let paths = 0;
  const animation = runtime.startAnimation(source, {
    getValue(current) {
      order.push("get");
      pointers.push(current.handle);
      expect(() => current.cancel()).toThrow();
      return 7;
    },
    path(current) {
      order.push("path");
      pointers.push(current.handle);
      expect(field(runtime, current.handle, "start_value") | 0).toBe(-3);
      expect(field(runtime, current.handle, "end_value") | 0).toBe(37);
      expect(() => current.cancel()).toThrow();
      expect(() => raw.lv_anim_refr_now()).toThrow();
      expect(() => raw.lv_anim_delete_all()).toThrow();
      return paths++ === 0 ? -123 : 321;
    },
    exec(current, value) {
      order.push(`exec:${value}`);
      pointers.push(current.handle);
      expect(field(runtime, current.handle, "var")).toBe(0xabcdef98);
      expect(raw.lv_anim_get_user_data(current.handle) >>> 0).toBe(0xf1234567);
      runtime.setText(label, String(value));
      expect(() => runtime.step(1)).toThrow();
      expect(() => runtime.shutdown()).toThrow();
      if (order.length === 3) expect(() => current.cancel()).toThrow();
    },
    start(current) {
      order.push("start");
      expect(() => current.cancel()).toThrow();
    },
    completed(current) { order.push("completed"); current.cancel(); },
    deleted(current) { order.push("deleted"); current.cancel(); },
  });
  expect(order).toEqual(["get", "path", "exec:-123"]);
  expect(animation.handle).not.toBe(source);
  expect(pointers.every((pointer) => pointer === animation.handle)).toBe(true);
  raw.lvw_free(source);
  const otherSource = descriptor(other);
  let otherCalls = 0;
  const independent = other.startAnimation(otherSource, { exec() { otherCalls++; } });
  other.unsafe.lvw_free(otherSource);
  runtime.step(33);
  expect(order).toEqual(["get", "path", "exec:-123", "start", "path", "exec:321"]);
  expect(otherCalls).toBe(0);
  runtime.step(33);
  expect(order.slice(-2)).toEqual(["completed", "deleted"]);
  expect(() => animation.handle).toThrow();
  animation.cancel();
  other.step(33);
  expect(otherCalls).toBe(1);
  independent.cancel();
  runtime.shutdown();
  other.shutdown();
});

test("animations sharing var cancel independently and native object deletion releases their handles", async () => {
  const runtime = await load();
  const other = await load();
  const raw = runtime.unsafe;
  const display = runtime.createDisplay(80, 60);
  const object = runtime.createButton(runtime.screen(display));
  const source = descriptor(runtime, false, 99, object.handle);
  const calls = [0, 0];
  const deleted = [0, 0];
  const first = runtime.startAnimation(source, {
    exec() { calls[0]++; }, deleted() { deleted[0]++; },
  });
  const second = runtime.startAnimation(source, {
    exec() { calls[1]++; }, deleted() { deleted[1]++; },
  });
  raw.lvw_free(source);
  expect(first.handle).not.toBe(second.handle);
  expect(() => other.cancelAnimation(first)).toThrow();
  first.cancel();
  first.cancel();
  runtime.step(33);
  expect(calls).toEqual([0, 1]);
  expect(deleted).toEqual([1, 0]);
  raw.lv_obj_delete(object.handle);
  expect(deleted).toEqual([1, 1]);
  expect(() => first.handle).toThrow();
  expect(() => second.handle).toThrow();
  second.cancel();

  const selfSource = descriptor(runtime, true);
  raw.lv_anim_set_var(selfSource, selfSource);
  const self = runtime.startAnimation(selfSource, {
    exec(current) { expect(field(runtime, current.handle, "var")).toBe(current.handle); },
  });
  expect(field(runtime, self.handle, "var")).toBe(self.handle);
  raw.lvw_free(selfSource);
  self.cancel();

  const closingSource = descriptor(runtime);
  const closing = [0, 0];
  const victim = runtime.startAnimation(closingSource, {
    exec() {}, deleted() { closing[1]++; },
  });
  const actor = runtime.startAnimation(closingSource, {
    exec() {},
    deleted(current) {
      closing[0]++;
      expect(() => current.handle).toThrow("closing");
      expect(() => raw.lv_anim_delete_all()).toThrow();
      victim.cancel();
      victim.cancel();
      current.cancel();
    },
  });
  raw.lvw_free(closingSource);
  runtime.shutdown();
  expect(closing).toEqual([1, 0]);
  expect(() => actor.handle).toThrow();
  expect(() => victim.handle).toThrow();
  other.shutdown();
});

test("animation pause, delay, repeat and reverse retain native completion order", async () => {
  const runtime = await load();
  const raw = runtime.unsafe;
  const source = descriptor(runtime, false, 33);
  raw.lv_anim_set_delay(source, 66);
  raw.lv_anim_set_repeat_count(source, 2);
  raw.lv_anim_set_reverse_duration(source, 33);
  let starts = 0;
  const values: number[] = [];
  const terminal: string[] = [];
  const animation = runtime.startAnimation(source, {
    start() { starts++; },
    exec(_current, value) { values.push(value); },
    completed() { terminal.push("completed"); },
    deleted() { terminal.push("deleted"); },
  });
  raw.lvw_free(source);
  runtime.step(33);
  expect(values).toEqual([]);
  raw.lv_anim_pause(animation.handle);
  runtime.step(100);
  expect(values).toEqual([]);
  expect(raw.lv_anim_is_paused(animation.handle)).toBe(1);
  raw.lv_anim_resume(animation.handle);
  for (let index = 0; index < 8; index++) runtime.step(33);
  expect(starts).toBe(4);
  expect(values).toContain(30);
  expect(values).toContain(-10);
  expect(terminal).toEqual(["completed", "deleted"]);
  expect(() => animation.handle).toThrow();
  runtime.shutdown();
});

test("tick exec can cancel animations and create a successor without reviving released handles", async () => {
  const runtime = await load();
  const raw = runtime.unsafe;
  const source = descriptor(runtime);
  let victimCalls = 0;
  let selfCalls = 0;
  let successorCalls = 0;
  let successor: Animation | undefined;
  const victim = runtime.startAnimation(source, { exec() { victimCalls++; } });
  const self = runtime.startAnimation(source, {
    exec(current) {
      selfCalls++;
      victim.cancel();
      current.cancel();
      expect(() => current.handle).toThrow();
      successor = runtime.startAnimation(source, { exec() { successorCalls++; } });
    },
  });
  runtime.step(33);
  expect([selfCalls, victimCalls]).toEqual([1, 0]);
  expect(() => self.handle).toThrow();
  expect(() => victim.handle).toThrow();
  const before = successorCalls;
  runtime.step(33);
  expect(successorCalls).toBeGreaterThan(before);
  successor!.cancel();
  raw.lvw_free(source);
  runtime.shutdown();
});

test("animation failures and invalid synchronous results poison the entire runtime", async () => {
  for (const failure of ["throw", "caught trap", "thenable", "fraction", "range", "nan"] as const) {
    const runtime = await load();
    const raw = runtime.unsafe;
    const source = descriptor(runtime);
    const marker = new Error("animation callback failed");
    const animation = runtime.startAnimation(source, {
      path(current) {
        if (failure === "throw") throw marker;
        if (failure === "caught trap") {
          expect(() => raw.lv_color_to_int(raw.memory.buffer.byteLength - 1)).toThrow(WebAssembly.RuntimeError);
          return 0;
        }
        if (failure === "thenable") return { then() {} } as unknown as number;
        if (failure === "fraction") return 1.5;
        if (failure === "range") return 0x80000000;
        expect(current.handle).toBeGreaterThan(0);
        return NaN;
      },
      exec() {},
    });
    raw.lvw_free(source);
    let escaped: unknown;
    try { runtime.step(33); } catch (error) { escaped = error; }
    expect(escaped).toBeDefined();
    if (failure === "throw") expect(escaped).toBe(marker);
    expect(() => animation.handle).toThrow();
    animation.cancel();
    expect(() => raw.lv_pow(2n, 3)).toThrow("poisoned");
    expect(() => runtime.shutdown()).toThrow("poisoned");
  }
});
