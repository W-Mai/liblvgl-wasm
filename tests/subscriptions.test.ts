import { expect, test } from "bun:test";
import {
  Display, LvglRuntime, ObjectRef,
  LV_EVENT_ALL, LV_EVENT_DELETE, LV_RESULT_OK,
} from "../bindings/typescript/src/index.ts";

async function setup() {
  const runtime = await LvglRuntime.load(await Bun.file("target/wasm/liblvgl.wasm").arrayBuffer());
  const display = runtime.createDisplay(80, 60);
  const pointer = runtime.createPointer(display);
  const screen = runtime.screen(display);
  const parent = runtime.createButton(screen);
  const child = runtime.createLabel(parent);
  return { runtime, display, pointer, screen, parent, child, api: runtime.unsafe, clicked: runtime.clickedEvent };
}

test("subscriptions remove guest descriptors and support cancellation during dispatch", async () => {
  const { runtime, parent, api, clicked } = await setup();
  const baseline = api.lv_obj_get_event_count(parent.handle);
  const calls: string[] = [];
  const stopRuntime = runtime.onEvent(parent, clicked, () => { calls.push("runtime"); });
  const stopObject = parent.on(clicked, () => { calls.push("object"); });
  expect(api.lv_obj_get_event_count(parent.handle)).toBe(baseline + 2);
  expect(api.lv_obj_send_event(parent.handle, clicked, 0)).toBe(LV_RESULT_OK);
  expect(calls).toEqual(["runtime", "object"]);

  stopRuntime();
  stopRuntime();
  expect(api.lv_obj_get_event_count(parent.handle)).toBe(baseline + 1);
  api.lv_obj_send_event(parent.handle, clicked, 0);
  expect(calls).toEqual(["runtime", "object", "object"]);
  stopObject();
  stopObject();
  expect(api.lv_obj_get_event_count(parent.handle)).toBe(baseline);
  api.lv_obj_send_event(parent.handle, clicked, 0);
  expect(calls).toEqual(["runtime", "object", "object"]);

  calls.length = 0;
  const stopA = parent.on(clicked, () => {
    calls.push("A");
    stopB();
    stopA();
  });
  const stopB = runtime.onEvent(parent, clicked, () => { calls.push("B"); });
  expect(api.lv_obj_get_event_count(parent.handle)).toBe(baseline + 2);
  api.lv_obj_send_event(parent.handle, clicked, 0);
  api.lv_obj_send_event(parent.handle, clicked, 0);
  expect(calls).toEqual(["A"]);
  expect(api.lv_obj_get_event_count(parent.handle)).toBe(baseline);
  runtime.shutdown();
});

for (const deletion of ["parent", "display", "async"] as const) {
  test(`${deletion} deletion invalidates every affected reference and preserves DELETE notifications`, async () => {
    const { runtime, display, pointer, screen, parent, child, api } = await setup();
    const parentAlias = new ObjectRef(runtime, parent.handle);
    const screenAlias = runtime.screen(display);
    const displayAlias = new Display(runtime, display.handle);
    const notifications: string[] = [];
    const stopDelete = child.on(LV_EVENT_DELETE, () => {
      notifications.push("DELETE");
      expect(() => childAlias.setSize(10, 10)).toThrow("invalid");
    });
    const childAlias = new ObjectRef(runtime, child.handle);
    const stopAll = childAlias.on(LV_EVENT_ALL, (code) => {
      if (code === LV_EVENT_DELETE) notifications.push("ALL");
    });

    if (deletion === "parent") parent.delete();
    else if (deletion === "display") runtime.destroyDisplay(display.handle);
    else {
      api.lv_obj_delete_async(parent.handle);
      runtime.step(1);
    }

    expect(notifications.toSorted()).toEqual(["ALL", "DELETE"]);
    for (const object of [parent, parentAlias, child, childAlias]) {
      expect(() => object.setSize(10, 10)).toThrow("invalid");
    }
    expect(() => runtime.createLabel(parent)).toThrow("invalid");
    for (const stop of [stopDelete, stopAll]) {
      expect(() => { stop(); stop(); }).not.toThrow();
    }

    if (deletion === "display") {
      for (const object of [screen, screenAlias]) {
        expect(() => object.setPosition(0, 0)).toThrow("invalid");
      }
      expect(() => display.resize(40, 30)).toThrow("invalid");
      expect(() => runtime.screen(displayAlias)).toThrow("invalid");
      expect(() => pointer.push(1, 1, true)).toThrow("invalid");
      const replacementDisplay = runtime.createDisplay(80, 60);
      runtime.createPointer(replacementDisplay).push(1, 1, false);
      expect(() => pointer.push(1, 1, false)).toThrow("invalid");
    } else {
      // Deleting an object subtree does not delete its display or input device.
      const replacement = runtime.createButton(screenAlias);
      replacement.setSize(10, 10);
      pointer.push(1, 1, false);
      runtime.step(1);
    }
    runtime.shutdown();
  });
}

for (const state of ["closing", "closed", "poisoned"] as const) {
  test(`unsubscribe is host-only and idempotent while ${state}`, async () => {
    const { runtime, parent, child, api, clicked } = await setup();
    const unsubscribe = child.on(clicked, () => {});
    let deleteCalls = 0;
    const stopDelete = parent.on(LV_EVENT_DELETE, () => {
      deleteCalls++;
      if (state === "closing") {
        expect(() => api.lv_pow(2n, 3)).toThrow("closing");
        unsubscribe();
        unsubscribe();
      }
    });

    if (state === "poisoned") {
      expect(() => api.lv_color_to_int(api.memory.buffer.byteLength - 1)).toThrow(WebAssembly.RuntimeError);
    } else {
      runtime.shutdown();
    }

    expect(deleteCalls).toBe(state === "poisoned" ? 0 : 1);
    expect(() => api.lv_pow(2n, 3)).toThrow(state === "closing" ? "closed" : state);
    expect(() => {
      unsubscribe();
      unsubscribe();
      stopDelete();
      stopDelete();
    }).not.toThrow();
  });
}

test("references from another runtime cannot create objects, inputs, or subscriptions", async () => {
  const first = await setup();
  const second = await setup();
  const baseline = second.api.lv_obj_get_event_count(second.parent.handle);
  expect(() => first.runtime.createButton(second.parent)).toThrow("invalid");
  expect(() => first.runtime.createPointer(second.display)).toThrow("invalid");
  expect(() => first.runtime.onEvent(second.parent, first.clicked, () => {})).toThrow("invalid");
  expect(second.api.lv_obj_get_event_count(second.parent.handle)).toBe(baseline);
  second.parent.setSize(20, 20);
  expect(second.api.lv_obj_send_event(second.parent.handle, second.clicked, 0)).toBe(LV_RESULT_OK);
  expect(first.api.lv_pow(2n, 3)).toBe(8n);
  first.runtime.shutdown();
  second.runtime.shutdown();
});
