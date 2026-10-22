import { expect, test } from "bun:test";
import { startCDemo } from "../studio/src/c-demo.ts";

async function preview(check: (env: {
  canvas: HTMLCanvasElement; abort: AbortController; calls: string[]; errors: unknown[];
  bytes: Uint8Array; tick(): void; point(): void; fault(name: string): void;
  frames: Uint8ClampedArray[];
}) => Promise<void>) {
  const bytes = await Bun.file("target/wasm/examples/c/liblvgl-c-demo.wasm").bytes();
  const names = ["fetch", "requestAnimationFrame", "cancelAnimationFrame", "ImageData"];
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const instantiate = WebAssembly.instantiate;
  const abort = new AbortController();
  const calls: string[] = [], errors: unknown[] = [], frames: Uint8ClampedArray[] = [];
  const callbacks = new Map<number, FrameRequestCallback>();
  let next = 0, time = performance.now(), fault = "";
  const canvas = Object.assign(new EventTarget(), {
    width: 320, height: 240,
    getContext: () => ({ putImageData: (image: ImageData) => frames.push(image.data.slice()) }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 240 }),
    setPointerCapture() {},
  }) as unknown as HTMLCanvasElement;
  const values: Record<string, unknown> = {
    fetch: async () => new Response(bytes),
    requestAnimationFrame: (callback: FrameRequestCallback) => { callbacks.set(++next, callback); return next; },
    cancelAnimationFrame: (id: number) => callbacks.delete(id),
    ImageData: class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} },
  };
  for (const name of names) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  WebAssembly.instantiate = (async (input: BufferSource, imports: WebAssembly.Imports) => {
    const result = await instantiate(input, imports);
    const native = result.instance.exports;
    // A facade can instrument immutable Wasm exports without violating Proxy invariants.
    const exports = new Proxy({}, { get(_, name: string) {
      if (typeof native[name] !== "function") return native[name];
      return (...args: number[]) => {
        calls.push(name);
        if (fault === name) {
          if (name === "lvw_abi_version") return 2;
          // Enter a real out-of-bounds guest read, then verify the preview never reenters it.
          return (native.lvw_step as Function)(1, 0xffffffff);
        }
        return (native[name] as Function)(...args);
      };
    }});
    return { module: result.module, instance: { exports } };
  }) as typeof WebAssembly.instantiate;
  try {
    await check({ canvas, abort, calls, errors, bytes, frames,
      fault(name) { fault = name; },
      tick() {
        const pending = [...callbacks.values()]; callbacks.clear(); time += 100;
        for (const callback of pending) callback(time);
      },
      point() {
        canvas.dispatchEvent(Object.assign(new Event("pointerdown"), { clientX: 160, clientY: 120, pointerId: 1 }));
      },
    });
  } finally {
    abort.abort();
    WebAssembly.instantiate = instantiate;
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

test("C preview identity describes its loaded native module and abort stops it exactly once", async () => {
  await preview(async ({ canvas, abort, calls, errors, bytes, frames, tick, point }) => {
    const demo = await startCDemo(canvas, abort.signal, (error) => errors.push(error));
    expect(demo.identity).toEqual({ path: "/target/wasm/examples/c/liblvgl-c-demo.wasm", bridgeAbi: 1,
      coreSha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
    tick();
    expect(frames[0]).toHaveLength(320 * 240 * 4);
    expect(new Set(frames[0]).size).toBeGreaterThan(2);
    abort.abort(); demo.stop();
    const count = calls.length;
    tick(); point();
    expect(calls).toHaveLength(count);
    expect(calls.filter((name) => name === "lvw_shutdown")).toHaveLength(1);
    expect(errors).toEqual([]);
  });
});

test.each(["lvw_step", "lvw_indev_push"])("C preview %s traps permanently stop guest calls without shutdown", async (operation) => {
  await preview(async ({ canvas, abort, calls, errors, tick, point, fault }) => {
    const demo = await startCDemo(canvas, abort.signal, (error) => errors.push(error));
    fault(operation);
    if (operation === "lvw_step") tick(); else point();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(WebAssembly.RuntimeError);
    const count = calls.length;
    tick(); point(); demo.stop(); abort.abort();
    expect(calls).toHaveLength(count);
    expect(calls).not.toContain("lvw_shutdown");
  });
});

test("C preview rejects an unsupported ABI before LVGL initialization", async () => {
  await preview(async ({ canvas, abort, calls, fault }) => {
    fault("lvw_abi_version");
    await expect(startCDemo(canvas, abort.signal, () => {})).rejects.toThrow("Unsupported C demo bridge ABI: 2");
    expect(calls).toEqual(["_initialize", "lvw_abi_version"]);
  });
});

test("cancelled C preview loads never initialize a guest", async () => {
  await preview(async ({ canvas, abort, calls }) => {
    const pending = startCDemo(canvas, abort.signal, () => {});
    abort.abort();
    await expect(pending).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
