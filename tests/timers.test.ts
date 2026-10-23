import { expect, test } from "bun:test";
import type { LvglRuntime as Runtime, Timer } from "../bindings/typescript/src/index.ts";

const { LV_EVENT_DELETE, LvglRuntime } = await import(
  Bun.env.LVW_TEST_TS_RUNTIME ?? "../bindings/typescript/src/index.ts"
) as typeof import("../bindings/typescript/src/index.ts");

async function load(): Promise<Runtime> {
  return LvglRuntime.load(await Bun.file(Bun.env.LVW_TEST_CORE ?? "target/wasm/liblvgl.wasm").arrayBuffer());
}

test("timers use their own instance clock and update UI and user data synchronously", async () => {
  const first = await load();
  const second = await load();
  const display = first.createDisplay(80, 60);
  const label = first.createLabel(first.screen(display));
  const raw = first.unsafe;
  const userData = raw.lvw_alloc(4);
  expect(userData).not.toBe(0);
  const calls = [0, 0];
  const timer = first.createTimer(10, (current) => {
    expect(raw.lv_timer_get_user_data(current.handle)).toBe(userData + (calls[0] ? 1 : 0));
    raw.lv_timer_set_user_data(current.handle, userData + 1);
    first.setText(label, "tick");
    calls[0]++;
    expect(() => first.step(1)).toThrow("not reentrant");
    expect(() => first.shutdown()).toThrow("not reentrant");
  }, userData);
  second.createTimer(10, () => { calls[1]++; });
  first.step(5);
  expect(calls).toEqual([0, 0]);
  second.step(10);
  expect(calls).toEqual([0, 1]);
  first.step(5);
  first.step(10);
  expect(calls).toEqual([2, 1]);
  const text = raw.lv_label_get_text(label.handle);
  expect([...new Uint8Array(raw.memory.buffer, text, 5)]).toEqual([116, 105, 99, 107, 0]);
  expect(() => second.cancelTimer(timer)).toThrow();
  timer.cancel();
  timer.cancel();
  raw.lvw_free(userData);
  first.shutdown();
  second.shutdown();
});

test("native repeat and deletion rules invalidate timers and preserve paused timers", async () => {
  const runtime = await load();
  const raw = runtime.unsafe;
  const calls = [0, 0, 0];
  const once = runtime.createTimer(10, () => { calls[0]++; });
  const zero = runtime.createTimer(10, () => { calls[1]++; });
  const paused = runtime.createTimer(10, () => { calls[2]++; });
  raw.lv_timer_set_repeat_count(once.handle, 1);
  raw.lv_timer_set_repeat_count(zero.handle, 0);
  raw.lv_timer_set_repeat_count(paused.handle, 1);
  raw.lv_timer_set_auto_delete(paused.handle, 0);
  runtime.step(10);
  expect(calls).toEqual([1, 0, 1]);
  expect(() => once.handle).toThrow();
  expect(() => zero.handle).toThrow();
  expect(raw.lv_timer_get_paused(paused.handle)).toBe(1);
  runtime.step(100);
  expect(calls).toEqual([1, 0, 1]);
  raw.lv_timer_set_repeat_count(paused.handle, 1);
  raw.lv_timer_resume(paused.handle);
  runtime.step(10);
  expect(calls).toEqual([1, 0, 2]);
  raw.lv_timer_delete(paused.handle);
  for (const timer of [once, zero, paused]) {
    expect(() => timer.handle).toThrow();
    timer.cancel();
    timer.cancel();
  }
  const remaining = runtime.createTimer(10, () => {});
  const display = runtime.createDisplay(80, 60);
  const object = runtime.createButton(runtime.screen(display));
  let closingNotifications = 0;
  object.on(LV_EVENT_DELETE, () => {
    closingNotifications++;
    expect(() => remaining.handle).toThrow("closing");
    remaining.cancel();
    remaining.cancel();
  });
  runtime.shutdown();
  expect(closingNotifications).toBe(1);
  expect(() => remaining.handle).toThrow();
  remaining.cancel();
});

test("timer callbacks can cancel themselves and other timers and create a successor", async () => {
  const runtime = await load();
  let victimCalls = 0;
  let selfCalls = 0;
  let successorCalls = 0;
  let successor: Timer | undefined;
  const victim = runtime.createTimer(50, () => { victimCalls++; });
  const self = runtime.createTimer(10, (current) => {
    selfCalls++;
    victim.cancel();
    current.cancel();
    expect(() => current.handle).toThrow();
    successor = runtime.createTimer(20, () => { successorCalls++; });
    runtime.unsafe.lv_timer_set_repeat_count(successor.handle, 1);
  });
  runtime.step(10);
  expect([selfCalls, victimCalls, successorCalls]).toEqual([1, 0, 0]);
  expect(() => self.handle).toThrow();
  expect(() => victim.handle).toThrow();
  runtime.step(20);
  expect([selfCalls, victimCalls, successorCalls]).toEqual([1, 0, 1]);
  expect(successor).toBeDefined();
  expect(() => successor!.handle).toThrow();
  runtime.step(100);
  expect([selfCalls, victimCalls, successorCalls]).toEqual([1, 0, 1]);
  runtime.shutdown();
});

test("timer exceptions, swallowed guest traps, and thenables permanently disable the instance", async () => {
  for (const failure of ["throw", "caught trap", "thenable"] as const) {
    const runtime = await load();
    const raw = runtime.unsafe;
    const marker = new Error("timer callback failure");
    const timer = runtime.createTimer(10, () => {
      if (failure === "throw") throw marker;
      if (failure === "caught trap") {
        expect(() => raw.lv_color_to_int(raw.memory.buffer.byteLength - 1))
          .toThrow(WebAssembly.RuntimeError);
      } else {
        return { then() {} };
      }
    });
    let escaped: unknown;
    try { runtime.step(10); } catch (error) { escaped = error; }
    expect(escaped).toBeDefined();
    if (failure === "throw") expect(escaped).toBe(marker);
    expect(() => raw.lv_pow(2n, 3)).toThrow("poisoned");
    expect(() => runtime.createTimer(10, () => {})).toThrow("poisoned");
    expect(() => timer.handle).toThrow();
    timer.cancel();
    expect(() => runtime.shutdown()).toThrow("poisoned");
  }
});
