import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Animation } from "../bindings/typescript/src/animation.ts";
import { DecoderSession, ImageDecoder } from "../bindings/typescript/src/decoder.ts";
import { Display, ObjectRef, Timer } from "../bindings/typescript/src/index.ts";
import { Observer } from "../bindings/typescript/src/observer.ts";
import { createEditorApi, editorModuleSource } from "../studio/src/editor-api.ts";
import type { AppApi } from "../toolchains/ts/api.ts";

function fakeApi(): AppApi {
  let bound = false;
  const runtime = {
    identity: { sdk: { status: "matched" } },
    clickedEvent: 1,
    deleteEvent: 2,
    eventPointer() { bound = this === runtime; return 3; },
    unsafe: Object.freeze({ lv_label_set_text() { return 4; } }),
    createLabel() { bound = this === runtime; return { handle: 5 }; },
  } as unknown as AppApi["runtime"];
  return {
    runtime,
    display: {} as AppApi["display"],
    screen: {} as AppApi["screen"],
    log() { /* no-op */ },
    get bound() { return bound; },
  } as unknown as AppApi & { bound: boolean };
}

describe("studio editor facade", () => {
  test("native functions are scoped to enabled editor code and retained by callbacks", async () => {
    const api = fakeApi();
    const source = "function main() { return () => lv_label_set_text(); }";
    const load = async (names: string[]) => {
      const text = editorModuleSource(source, names);
      return (await import(`data:text/javascript,${encodeURIComponent(text)}`)).default as (api: unknown) => () => number;
    };
    const enabled = await load(Object.keys(api.runtime.unsafe));
    expect(enabled(createEditorApi(api, true))()).toBe(4);
    const disabled = await load([]);
    expect(() => disabled(createEditorApi(api, false))()).toThrow(ReferenceError);
    expect("lv_label_set_text" in globalThis).toBe(false);
    const shadow = editorModuleSource("function main() { const lv_label_set_text = () => 9; return lv_label_set_text(); }", ["lv_label_set_text"]);
    expect((await import(`data:text/javascript,${encodeURIComponent(shadow)}`)).default(createEditorApi(api, true))).toBe(9);
  });
  test("keeps high-level calls bound and gates native access", () => {
    const api = fakeApi();
    const closed = createEditorApi(api, false);
    expect(closed.runtime.createLabel(closed.screen).handle).toBe(5);
    expect((api as AppApi & { bound: boolean }).bound).toBe(true);
    expect(() => closed.runtime.unsafe).toThrow("Native LVGL API is disabled");
    expect(() => closed.runtime.eventPointer).toThrow("Native LVGL API is disabled");

    const open = createEditorApi(api, true);
    expect(open.runtime.unsafe).toBe(api.runtime.unsafe);
    expect(open.runtime.eventPointer()).toBe(3);
  });

  test("managed wrappers do not expose host registries through reflection", () => {
    const runtime = {
      trackDisplay: () => () => {},
      trackObject: () => () => {},
    } as never;
    const wrappers = [
      new Timer(runtime),
      new Display(runtime, 1),
      new ObjectRef(runtime, 1),
      new Animation({} as never),
      new Observer({} as never),
      new ImageDecoder({} as never),
      new DecoderSession({} as never),
    ];
    for (const wrapper of wrappers) {
      expect(Object.getOwnPropertyNames(wrapper)).not.toContain("runtime");
      expect(Object.getOwnPropertyNames(wrapper)).not.toContain("registry");
    }
  });

  test("editor execution stays compatible with the iframe CSP", () => {
    const worker = readFileSync(new URL("../studio/src/worker.ts", import.meta.url), "utf8");
    const controller = readFileSync(new URL("../studio/src/controller.ts", import.meta.url), "utf8");
    expect(worker).not.toContain("new Function");
    expect(controller).toContain("script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'");
    expect(controller).not.toContain("'unsafe-eval'");
    expect(controller).toContain("worker?.terminate()");
    expect(controller).toContain("URL.revokeObjectURL(workerUrl)");
    expect(controller).toContain('addEventListener("pagehide", disposeWorker)');
    expect(controller).toContain('this.stop();');
  });
});
