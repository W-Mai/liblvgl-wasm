import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { createWasiImports } from "../../bindings/typescript/src/wasi.ts";

type DemoCore = {
  memory: WebAssembly.Memory;
  _initialize(): void;
  lvw_abi_version(): number;
  lvw_init(): number;
  lvw_shutdown(): number;
  lvw_display_create(width: number, height: number, format: number): number;
  lvw_indev_create(display: number, type: number): number;
  lvw_demo_create(display: number): void;
  lvw_alloc(bytes: number): number;
  lvw_indev_push(indev: number, packet: number, size: number): number;
  lvw_step(elapsed: number, result: number): number;
  lvw_frame_get(display: number, result: number): number;
};

export interface CDemo {
  identity: { path: string; bridgeAbi: number; coreSha256: string };
  stop(): void;
}

export async function startCDemo(canvas: HTMLCanvasElement, signal: AbortSignal,
                                 onError: (error: unknown) => void): Promise<CDemo> {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context is unavailable");
  const path = "/target/wasm/examples/c/liblvgl-c-demo.wasm";
  const response = await fetch(path, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load C demo (${response.status})`);
  const bytes = await response.arrayBuffer();
  signal.throwIfAborted();
  const coreSha256 = bytesToHex(sha256(new Uint8Array(bytes)));
  let core: DemoCore;
  const { instance } = await WebAssembly.instantiate(bytes, {
    lvw: {
      event() {}, timer() {}, timer_release() {},
      anim_exec() {}, anim_query() { return 0; }, anim_notify() {}, anim_release() {},
      observer() {}, observer_release() {},
      decoder_info() { return 0; }, decoder_open() { return 0; }, decoder_area() { return 0; },
      decoder_close() {}, decoder_release() {},
    },
    wasi_snapshot_preview1: createWasiImports(() => core?.memory),
  });
  signal.throwIfAborted();
  core = instance.exports as unknown as DemoCore;
  core._initialize();
  const bridgeAbi = core.lvw_abi_version();
  if (bridgeAbi !== 1) throw new Error(`Unsupported C demo bridge ABI: ${bridgeAbi}`);
  if (core.lvw_init() !== 0) throw new Error("LVGL initialization failed");

  const display = core.lvw_display_create(canvas.width, canvas.height, 1);
  const pointer = core.lvw_indev_create(display, 1);
  if (!display || !pointer) throw new Error("Display initialization failed");
  core.lvw_demo_create(display);

  const step = core.lvw_alloc(16);
  const frame = core.lvw_alloc(48);
  const input = core.lvw_alloc(32);
  if (!step || !frame || !input) throw new Error("LVGL allocation failed");
  const view = () => new DataView(core.memory.buffer);
  for (const [address, size] of [[step, 16], [frame, 48], [input, 32]]) {
    view().setUint32(address, size, true);
    view().setUint32(address + 4, 1, true);
  }

  let last = performance.now();
  let request = 0;
  let stopped = false;
  function fail(error: unknown): void {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(request);
    // A failed guest must never be entered again, including for shutdown.
    onError(error);
  }
  function stop(): void {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(request);
    try {
      if (core.lvw_shutdown() !== 0) throw new Error("LVGL shutdown failed");
    } catch (error) {
      onError(error);
    }
  }
  function pushPointer(event: PointerEvent, pressed: boolean): void {
    if (stopped) return;
    try {
      if (event.type === "pointerdown") canvas.setPointerCapture(event.pointerId);
      const bounds = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(canvas.width - 1,
        Math.floor((event.clientX - bounds.left) * canvas.width / bounds.width)));
      const y = Math.max(0, Math.min(canvas.height - 1,
        Math.floor((event.clientY - bounds.top) * canvas.height / bounds.height)));
      view().setUint32(input + 8, 1, true);
      view().setInt32(input + 12, x, true);
      view().setInt32(input + 16, y, true);
      view().setUint32(input + 20, pressed ? 1 : 0, true);
      if (core.lvw_indev_push(pointer, input, 32) !== 0) throw new Error("Pointer input failed");
    } catch (error) {
      fail(error);
    }
  }

  canvas.addEventListener("pointerdown", (event) => pushPointer(event, true), { signal });
  canvas.addEventListener("pointermove", (event) => {
    if (event.buttons & 1) pushPointer(event, true);
  }, { signal });
  canvas.addEventListener("pointerup", (event) => pushPointer(event, false), { signal });
  canvas.addEventListener("pointercancel", (event) => pushPointer(event, false), { signal });
  signal.addEventListener("abort", stop, { once: true });

  function tick(now: number): void {
    if (stopped) return;
    try {
      const elapsed = Math.min(100, Math.max(0, Math.round(now - last)));
      last = now;
      if (core.lvw_step(elapsed, step) !== 0) throw new Error("LVGL timer failed");
      if (view().getUint32(step + 12, true)) {
        if (core.lvw_frame_get(display, frame) !== 0) throw new Error("Frame read failed");
        const source = new Uint8Array(core.memory.buffer,
          view().getUint32(frame + 8, true), view().getUint32(frame + 12, true));
        const pixels = new Uint8ClampedArray(source.length);
        for (let index = 0; index < source.length; index += 4) {
          pixels[index] = source[index + 2];
          pixels[index + 1] = source[index + 1];
          pixels[index + 2] = source[index];
          pixels[index + 3] = 255;
        }
        context!.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
      }
      request = requestAnimationFrame(tick);
    } catch (error) {
      fail(error);
    }
  }
  request = requestAnimationFrame(tick);
  return { identity: { path, bridgeAbi, coreSha256 }, stop };
}
