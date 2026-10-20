import { sha256 } from "@noble/hashes/sha2.js";
import {
  bindingIdentity, createUnsafeLvglApi,
  type UnsafeFunctionPointer, type UnsafeLvglApi, type UnsafePointer,
} from "../../../target/typescript/raw.ts";
import { valuesIdentity } from "../../../target/typescript/values.ts";

export { bindingIdentity };
export type { UnsafeFunctionPointer, UnsafeLvglApi, UnsafePointer };
export * from "../../../target/typescript/values.ts";

const ABI_VERSION = 1;
const PIXEL_XRGB8888 = 1;
const INPUT_POINTER = 1;

interface RawExports {
  memory: WebAssembly.Memory;
  _initialize(): void;
  lvw_abi_version(): number;
  lvw_init(): number;
  lvw_shutdown(): number;
  lvw_alloc(bytes: number): number;
  lvw_free(pointer: number): void;
  lvw_display_create(width: number, height: number, format: number): number;
  lvw_display_resize(display: number, width: number, height: number): number;
  lvw_display_destroy(display: number): number;
  lvw_indev_create(display: number, type: number): number;
  lvw_indev_push(indev: number, packet: number, size: number): number;
  lvw_step(elapsedMs: number, result: number): number;
  lvw_frame_get(display: number, frame: number): number;
  lvw_resource_put(name: number, nameLength: number, bytes: number, byteLength: number): number;
  lvw_event_add(object: number, code: number, callbackId: number): number;
  lvw_event_clicked(): number;
  lvw_event_delete(): number;
  lv_display_get_screen_active(display: number): number;
  lv_button_create(parent: number): number;
  lv_label_create(parent: number): number;
  lv_image_create(parent: number): number;
  lv_image_set_src(object: number, source: number): void;
  lv_label_set_text(object: number, text: number): void;
  lv_obj_set_size(object: number, width: number, height: number): void;
  lv_obj_set_pos(object: number, x: number, y: number): void;
  lv_obj_delete(object: number): void;
}

export interface DirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Frame {
  width: number;
  height: number;
  frameId: number;
  dirty: DirtyRect[];
  rgba: Uint8ClampedArray;
}

export interface StepResult {
  nextMs: number;
  framesChanged: number;
}

/** Calls use pointers into this core's memory. The caller owns bounds, alignment, initialization, and lifetime. Recreate memory views after memory growth. Pair scratch allocations with lvw_free; use runtime methods for lifecycle. */
export interface UnsafeLvgl extends UnsafeLvglApi {
  readonly memory: WebAssembly.Memory;
  lvw_alloc(bytes: number): UnsafePointer;
  lvw_free(pointer: UnsafePointer): void;
}

function check(status: number, operation: string): void {
  if (status !== 0) throw new Error(`${operation} failed (${status})`);
}

export class LvglRuntime {
  private readonly callbacks = new Map<number, (object: number, code: number) => void>();
  private nextCallbackId = 1;
  private active = true;
  private stepping = false;
  private unsafeApi?: UnsafeLvgl;

  private constructor(private readonly raw: RawExports, private readonly coreHash: string) {}

  static async load(bytes: BufferSource): Promise<LvglRuntime> {
    const snapshot = (ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(bytes)).slice();
    const coreHash = Array.from(sha256(snapshot), (byte) => byte.toString(16).padStart(2, "0")).join("");
    let memory: WebAssembly.Memory | undefined;
    let runtime: LvglRuntime | undefined;
    const decoder = new TextDecoder();
    const module = await WebAssembly.compile(snapshot);
    const imports = WebAssembly.Module.imports(module).map((item) => `${item.module}.${item.name}`);
    const expected = new Set(["lvw.event", "wasi_snapshot_preview1.fd_close", "wasi_snapshot_preview1.fd_write"]);
    for (const item of imports) {
      if (!expected.has(item)) throw new Error(`unsupported Wasm import: ${item}`);
    }
    const instance = await WebAssembly.instantiate(module, {
      lvw: {
        event(callbackId: number, object: number, code: number) {
          runtime?.dispatch(callbackId, object, code);
        },
      },
      wasi_snapshot_preview1: {
        fd_close() { return 0; },
        fd_write(fd: number, iovPointer: number, iovCount: number, writtenPointer: number) {
          if (!memory) return 8;
          const view = new DataView(memory.buffer);
          const chunks: Uint8Array[] = [];
          let written = 0;
          for (let index = 0; index < iovCount; index++) {
            const pointer = view.getUint32(iovPointer + index * 8, true);
            const length = view.getUint32(iovPointer + index * 8 + 4, true);
            chunks.push(new Uint8Array(memory.buffer, pointer, length));
            written += length;
          }
          view.setUint32(writtenPointer, written, true);
          const line = decoder.decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk])));
          if (line.trim()) (fd === 2 ? console.error : console.log)(line.trimEnd());
          return 0;
        },
      },
    });
    const raw = instance.exports as unknown as RawExports;
    memory = raw.memory;
    raw._initialize();
    if (raw.lvw_abi_version() !== ABI_VERSION) throw new Error("unsupported bridge ABI");
    check(raw.lvw_init(), "lvw_init");
    runtime = new LvglRuntime(raw, coreHash);
    return runtime;
  }

  /** Generated lv_* calls for the exact core recorded in bindingIdentity. */
  get unsafe(): UnsafeLvgl {
    this.ensureActive();
    if (this.coreHash !== bindingIdentity.wasm_sha256) {
      throw new Error("LVGL bindings do not match this core; generate bindings for the selected core");
    }
    if (valuesIdentity.api_sha256 !== bindingIdentity.api_sha256
        || valuesIdentity.wasm_sha256 !== bindingIdentity.wasm_sha256) {
      throw new Error("LVGL constants and layouts do not match these bindings; regenerate the SDK");
    }
    if (!this.unsafeApi) {
      const runtime = this;
      this.unsafeApi = Object.freeze({
        ...createUnsafeLvglApi(this.raw as unknown as Record<string, unknown>, () => this.ensureActive()),
        get memory(): WebAssembly.Memory {
          runtime.ensureActive();
          return runtime.raw.memory;
        },
        lvw_alloc(bytes: number): UnsafePointer {
          runtime.ensureActive();
          return runtime.raw.lvw_alloc(bytes);
        },
        lvw_free(pointer: UnsafePointer): void {
          runtime.ensureActive();
          runtime.raw.lvw_free(pointer);
        },
      });
    }
    return this.unsafeApi;
  }

  private ensureActive(): void {
    if (!this.active) throw new Error("LVGL runtime is closed");
  }

  private view(): DataView {
    return new DataView(this.raw.memory.buffer);
  }

  private withBytes<T>(bytes: Uint8Array, callback: (pointer: number) => T): T {
    const pointer = this.raw.lvw_alloc(bytes.byteLength + 1);
    if (!pointer) throw new Error("Wasm allocation failed");
    try {
      new Uint8Array(this.raw.memory.buffer, pointer, bytes.byteLength).set(bytes);
      new Uint8Array(this.raw.memory.buffer)[pointer + bytes.byteLength] = 0;
      return callback(pointer);
    } finally {
      this.raw.lvw_free(pointer);
    }
  }

  private withStruct<T>(size: number, callback: (pointer: number) => T): T {
    const pointer = this.raw.lvw_alloc(size);
    if (!pointer) throw new Error("Wasm allocation failed");
    try {
      new Uint8Array(this.raw.memory.buffer, pointer, size).fill(0);
      const view = this.view();
      view.setUint32(pointer, size, true);
      view.setUint32(pointer + 4, ABI_VERSION, true);
      return callback(pointer);
    } finally {
      this.raw.lvw_free(pointer);
    }
  }

  createDisplay(width: number, height: number): Display {
    this.ensureActive();
    const handle = this.raw.lvw_display_create(width, height, PIXEL_XRGB8888);
    if (!handle) throw new Error("lvw_display_create failed");
    return new Display(this, handle);
  }

  createPointer(display: Display): PointerInput {
    this.ensureActive();
    display.assertOwner(this);
    const handle = this.raw.lvw_indev_create(display.handle, INPUT_POINTER);
    if (!handle) throw new Error("lvw_indev_create failed");
    return new PointerInput(this, handle);
  }

  screen(display: Display): ObjectRef {
    this.ensureActive();
    display.assertOwner(this);
    return new ObjectRef(this, this.raw.lv_display_get_screen_active(display.handle));
  }

  createButton(parent: ObjectRef): ObjectRef {
    parent.assertOwner(this);
    return new ObjectRef(this, this.raw.lv_button_create(parent.handle));
  }

  createLabel(parent: ObjectRef): ObjectRef {
    parent.assertOwner(this);
    return new ObjectRef(this, this.raw.lv_label_create(parent.handle));
  }

  createImage(parent: ObjectRef): ObjectRef {
    parent.assertOwner(this);
    return new ObjectRef(this, this.raw.lv_image_create(parent.handle));
  }

  setText(label: ObjectRef, value: string): void {
    label.assertOwner(this);
    this.withBytes(new TextEncoder().encode(value), (pointer) => this.raw.lv_label_set_text(label.handle, pointer));
  }

  setImageSource(image: ObjectRef, path: string): void {
    image.assertOwner(this);
    this.withBytes(new TextEncoder().encode(path), (pointer) => this.raw.lv_image_set_src(image.handle, pointer));
  }

  putResource(name: string, bytes: Uint8Array): void {
    this.ensureActive();
    this.withBytes(new TextEncoder().encode(name), (namePointer) => {
      this.withBytes(bytes, (dataPointer) => {
        check(this.raw.lvw_resource_put(namePointer, new TextEncoder().encode(name).length,
          dataPointer, bytes.length), "lvw_resource_put");
      });
    });
  }

  step(elapsedMs: number): StepResult {
    this.ensureActive();
    if (this.stepping) throw new Error("lvw_step is not reentrant");
    this.stepping = true;
    try {
      return this.withStruct(16, (pointer) => {
        check(this.raw.lvw_step(elapsedMs, pointer), "lvw_step");
        const view = this.view();
        return { nextMs: view.getUint32(pointer + 8, true), framesChanged: view.getUint32(pointer + 12, true) };
      });
    } finally {
      this.stepping = false;
    }
  }

  readFrame(display: Display): Frame {
    this.ensureActive();
    display.assertOwner(this);
    return this.withStruct(48, (pointer) => {
      check(this.raw.lvw_frame_get(display.handle, pointer), "lvw_frame_get");
      const view = this.view();
      const pixelsPointer = view.getUint32(pointer + 8, true);
      const byteLength = view.getUint32(pointer + 12, true);
      const width = view.getUint32(pointer + 16, true);
      const height = view.getUint32(pointer + 20, true);
      const dirtyPointer = view.getUint32(pointer + 36, true);
      const dirtyCount = view.getUint32(pointer + 40, true);
      const frameId = view.getUint32(pointer + 44, true);
      const dirty: DirtyRect[] = [];
      for (let index = 0; index < dirtyCount; index++) {
        const base = dirtyPointer + index * 16;
        dirty.push({ x: view.getUint32(base, true), y: view.getUint32(base + 4, true),
          width: view.getUint32(base + 8, true), height: view.getUint32(base + 12, true) });
      }
      const bgra = new Uint8Array(this.raw.memory.buffer, pixelsPointer, byteLength);
      const rgba = new Uint8ClampedArray(byteLength);
      for (let index = 0; index < byteLength; index += 4) {
        rgba[index] = bgra[index + 2];
        rgba[index + 1] = bgra[index + 1];
        rgba[index + 2] = bgra[index];
        rgba[index + 3] = 255;
      }
      return { width, height, frameId, dirty, rgba };
    });
  }

  onEvent(object: ObjectRef, code: number, callback: (code: number) => void): void {
    object.assertOwner(this);
    const id = this.nextCallbackId++;
    this.callbacks.set(id, (_object, eventCode) => callback(eventCode));
    check(this.raw.lvw_event_add(object.handle, code, id), "lvw_event_add");
  }

  private dispatch(callbackId: number, object: number, code: number): void {
    this.callbacks.get(callbackId)?.(object, code);
  }

  get clickedEvent(): number { return this.raw.lvw_event_clicked(); }
  get deleteEvent(): number { return this.raw.lvw_event_delete(); }

  setObjectSize(object: ObjectRef, width: number, height: number): void {
    object.assertOwner(this);
    this.raw.lv_obj_set_size(object.handle, width, height);
  }

  setObjectPosition(object: ObjectRef, x: number, y: number): void {
    object.assertOwner(this);
    this.raw.lv_obj_set_pos(object.handle, x, y);
  }

  deleteObject(object: ObjectRef): void {
    object.assertOwner(this);
    this.raw.lv_obj_delete(object.handle);
  }

  pushPointer(handle: number, x: number, y: number, pressed: boolean): void {
    this.ensureActive();
    this.withStruct(32, (pointer) => {
      const view = this.view();
      view.setUint32(pointer + 8, INPUT_POINTER, true);
      view.setInt32(pointer + 12, x, true);
      view.setInt32(pointer + 16, y, true);
      view.setUint32(pointer + 20, pressed ? 1 : 0, true);
      check(this.raw.lvw_indev_push(handle, pointer, 32), "lvw_indev_push");
    });
  }

  resizeDisplay(handle: number, width: number, height: number): void {
    this.ensureActive();
    check(this.raw.lvw_display_resize(handle, width, height), "lvw_display_resize");
  }

  destroyDisplay(handle: number): void {
    this.ensureActive();
    check(this.raw.lvw_display_destroy(handle), "lvw_display_destroy");
  }

  shutdown(): void {
    this.ensureActive();
    check(this.raw.lvw_shutdown(), "lvw_shutdown");
    this.active = false;
    this.callbacks.clear();
  }
}

export class Display {
  private alive = true;

  constructor(private readonly runtime: LvglRuntime, readonly handle: number) {}

  assertOwner(runtime: LvglRuntime): void {
    if (runtime !== this.runtime || !this.alive) throw new Error("invalid display reference");
  }

  resize(width: number, height: number): void {
    this.assertOwner(this.runtime);
    this.runtime.resizeDisplay(this.handle, width, height);
  }

  destroy(): void {
    this.assertOwner(this.runtime);
    this.runtime.destroyDisplay(this.handle);
    this.alive = false;
  }
}

export class PointerInput {
  constructor(private readonly runtime: LvglRuntime, private readonly handle: number) {}

  push(x: number, y: number, pressed: boolean): void {
    this.runtime.pushPointer(this.handle, x, y, pressed);
  }
}

export class ObjectRef {
  private alive = true;

  constructor(private readonly runtime: LvglRuntime, readonly handle: number) {
    if (!handle) throw new Error("LVGL object creation failed");
    runtime.onEvent(this, runtime.deleteEvent, () => { this.alive = false; });
  }

  assertOwner(runtime: LvglRuntime): void {
    if (runtime !== this.runtime || !this.alive) throw new Error("invalid LVGL object reference");
  }

  setSize(width: number, height: number): void { this.runtime.setObjectSize(this, width, height); }
  setPosition(x: number, y: number): void { this.runtime.setObjectPosition(this, x, y); }
  on(code: number, callback: (code: number) => void): void { this.runtime.onEvent(this, code, callback); }
  delete(): void { this.runtime.deleteObject(this); }
}
