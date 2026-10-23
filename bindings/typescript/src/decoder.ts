import type { UnsafePointer } from "../../../target/typescript/raw.ts";

export interface ImageDecoderCallbacks {
  info(session: DecoderSession, header: UnsafePointer): 0 | 1;
  open(session: DecoderSession): 0 | 1;
  getArea?(session: DecoderSession, fullArea: UnsafePointer, decodedArea: UnsafePointer): 0 | 1;
  close?(session: DecoderSession): void;
}

/** A value snapshot. Its pointers borrow guest storage for the current synchronous callback only. */
export interface DecoderView {
  readonly structSize: number;
  readonly version: number;
  readonly src: UnsafePointer;
  readonly srcType: number;
  readonly header: UnsafePointer;
  readonly decoded: UnsafePointer;
  readonly palette: UnsafePointer;
  readonly paletteSize: number;
  readonly userData: UnsafePointer;
  readonly decoderUserData: UnsafePointer;
  /** Borrowed native info file, or zero when unavailable (including LVGL 9.0). */
  readonly file: UnsafePointer;
  readonly argsFlags: number;
  readonly timeToOpen: number;
  readonly errorMessage: UnsafePointer;
  readonly phase: number;
  readonly reserved: number;
}

/** Session output for open, getArea, or close. Omitted fields are written as zero. */
export interface DecoderOutput {
  decoded: UnsafePointer;
  palette?: UnsafePointer;
  paletteSize?: number;
  userData?: UnsafePointer;
  timeToOpen?: number;
  errorMessage?: UnsafePointer;
}

/** @internal */
export interface DecoderExports {
  memory: WebAssembly.Memory;
  lvw_alloc(size: number): number;
  lvw_free(pointer: number): void;
  lvw_decoder_create?(userData: number, id: number, flags: number): number;
  lvw_decoder_delete?(decoder: number, id: number): number;
  lvw_decoder_read?(decoder: number, session: number, output: number, size: number): number;
  lvw_decoder_write?(decoder: number, session: number, decoded: number, palette: number,
                     paletteSize: number, userData: number, timeToOpen: number, errorMessage: number): number;
}

interface Host {
  ensureActive(): void;
  rethrowFailure(): void;
  poison(error: unknown): never;
  ready(): boolean;
  closing(): boolean;
  allocateId(): number;
}

interface Lifetime {
  id: number;
  handle: number;
  alive: boolean;
}

interface Registration {
  owner: Lifetime;
  decoder: ImageDecoder;
  callbacks: ImageDecoderCallbacks;
}

interface Frame {
  owner: Lifetime;
  decoder: ImageDecoder;
  pointer: number;
  phase: number;
  active: boolean;
}

function unsigned(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
  return value;
}

function check(status: number, operation: string): void {
  if (status !== 0) throw new Error(`${operation} failed (${status})`);
}

/** A native decoder registration. Cancellation requires all opened sessions to be closed. */
export class ImageDecoder {
  /** @internal Use LvglRuntime.createImageDecoder(). */
  constructor(private readonly registry: DecoderRegistry) {}

  get handle(): UnsafePointer { return this.registry.handle(this); }

  /** Repeated cancellation after native deletion, shutdown, or failure does not enter the guest. */
  cancel(): void { this.registry.cancel(this); }
}

/** Borrowed access to the innermost synchronous decoder callback. Saved sessions expire on return. */
export class DecoderSession {
  /** @internal Sessions are supplied to image decoder callbacks. */
  constructor(private readonly registry: DecoderRegistry) {}

  get decoder(): ImageDecoder { return this.registry.frame(this).decoder; }
  get pointer(): UnsafePointer { return this.registry.frame(this).pointer; }
  read(): DecoderView { return this.registry.read(this); }
  write(output: DecoderOutput): void { this.registry.write(this, output); }
}

/** @internal */
export class DecoderRegistry {
  private readonly registrations = new Map<number, Registration>();
  private readonly references = new WeakMap<ImageDecoder, Lifetime>();
  private readonly sessions = new WeakMap<DecoderSession, Frame>();
  private readonly frames: Frame[] = [];

  constructor(private readonly core: DecoderExports, private readonly host: Host) {}

  create(callbacks: ImageDecoderCallbacks, userData: number): ImageDecoder {
    this.host.ensureActive();
    unsigned(userData, "userData");
    const handlers = { info: callbacks?.info, open: callbacks?.open,
      getArea: callbacks?.getArea, close: callbacks?.close };
    for (const name of ["info", "open", "getArea", "close"] as const) {
      if (typeof handlers[name] !== "function" && (name === "info" || name === "open" || handlers[name] !== undefined)) {
        throw new TypeError(`image decoder ${name} callback must be a function`);
      }
    }
    for (const name of ["lvw_decoder_create", "lvw_decoder_delete", "lvw_decoder_read", "lvw_decoder_write"] as const) {
      if (typeof this.core[name] !== "function") {
        throw new Error(`missing Wasm function: ${name} (required for image decoder callbacks)`);
      }
    }
    const id = this.host.allocateId();
    const owner: Lifetime = { id, handle: 0, alive: true };
    const decoder = new ImageDecoder(this);
    this.references.set(decoder, owner);
    this.registrations.set(id, { owner, decoder, callbacks: handlers });
    try {
      owner.handle = this.core.lvw_decoder_create!(userData, id,
        (handlers.getArea ? 1 : 0) | (handlers.close ? 2 : 0)) >>> 0;
      if (!owner.handle) throw new Error("lvw_decoder_create failed");
      return decoder;
    } catch (error) {
      this.release(id);
      throw error;
    }
  }

  handle(decoder: ImageDecoder): UnsafePointer {
    this.host.ensureActive();
    const owner = this.references.get(decoder);
    if (!owner?.alive || !owner.handle) throw new Error("invalid LVGL image decoder reference");
    return owner.handle;
  }

  cancel(decoder: ImageDecoder): void {
    const owner = this.references.get(decoder);
    if (!owner) throw new Error("invalid LVGL image decoder reference");
    if (!owner.alive) return;
    if (this.host.ready()) check(this.core.lvw_decoder_delete!(owner.handle, owner.id), "lvw_decoder_delete");
    this.release(owner.id);
  }

  frame(session: DecoderSession): Frame {
    this.host.ensureActive();
    const frame = this.sessions.get(session);
    if (!frame?.active || !frame.owner.alive || this.frames.at(-1) !== frame) {
      throw new Error("image decoder session is not the active innermost callback");
    }
    return frame;
  }

  read(session: DecoderSession): DecoderView {
    const frame = this.frame(session);
    const pointer = this.core.lvw_alloc(64) >>> 0;
    if (!pointer) throw new Error("lvw_alloc failed");
    try {
      check(this.core.lvw_decoder_read!(frame.owner.handle, frame.pointer, pointer, 64), "lvw_decoder_read");
      const data = new DataView(this.core.memory.buffer, pointer, 64);
      const u32 = (index: number) => data.getUint32(index * 4, true);
      if (u32(0) !== 64 || u32(1) !== 1 || u32(14) !== frame.phase) {
        this.host.poison(new Error("invalid LVGL image decoder view"));
      }
      return Object.freeze({ structSize: u32(0), version: u32(1), src: u32(2), srcType: u32(3),
        header: u32(4), decoded: u32(5), palette: u32(6), paletteSize: u32(7), userData: u32(8),
        decoderUserData: u32(9), file: u32(10), argsFlags: u32(11), timeToOpen: u32(12),
        errorMessage: u32(13), phase: u32(14), reserved: u32(15) });
    } finally {
      if (this.host.ready()) this.core.lvw_free(pointer);
    }
  }

  write(session: DecoderSession, output: DecoderOutput): void {
    const frame = this.frame(session);
    if (frame.phase === 1) throw new Error("image decoder info callback cannot write session output");
    const values = [unsigned(output.decoded, "decoded"), unsigned(output.palette ?? 0, "palette"),
      unsigned(output.paletteSize ?? 0, "paletteSize"), unsigned(output.userData ?? 0, "userData"),
      unsigned(output.timeToOpen ?? 0, "timeToOpen"), unsigned(output.errorMessage ?? 0, "errorMessage")] as const;
    check(this.core.lvw_decoder_write!(frame.owner.handle, frame.pointer, ...values), "lvw_decoder_write");
  }

  dispatch(id: number, pointer: number, sessionPointer: number, phase: number,
           first = 0, second = 0): number {
    this.host.rethrowFailure();
    if (this.host.closing()) return 0;
    this.host.ensureActive();
    const registration = this.registrations.get(id >>> 0);
    pointer >>>= 0;
    sessionPointer >>>= 0;
    if (!registration || !pointer || !sessionPointer || registration.owner.handle !== pointer) {
      throw new Error("invalid LVGL image decoder callback");
    }
    const frame: Frame = { owner: registration.owner, decoder: registration.decoder,
      pointer: sessionPointer, phase, active: true };
    const session = new DecoderSession(this);
    this.sessions.set(session, frame);
    this.frames.push(frame);
    try {
      const callbacks = registration.callbacks;
      let result: unknown;
      if (phase === 1) result = callbacks.info(session, first >>> 0);
      else if (phase === 2) result = callbacks.open(session);
      else if (phase === 3) {
        if (!callbacks.getArea) throw new Error("missing LVGL image decoder getArea callback");
        result = callbacks.getArea(session, first >>> 0, second >>> 0);
      } else if (phase === 4) result = callbacks.close?.(session);
      else throw new Error("invalid LVGL image decoder callback phase");
      if (result !== null && (typeof result === "object" || typeof result === "function")
          && typeof (result as { then?: unknown }).then === "function") {
        void Promise.resolve(result).catch(() => {});
        this.host.rethrowFailure();
        throw new Error("LVGL image decoder callbacks must finish synchronously; thenables are not supported");
      }
      this.host.rethrowFailure();
      if (phase !== 4 && result !== 0 && result !== 1) {
        throw new Error("LVGL image decoder callbacks must return LV_RESULT_INVALID (0) or LV_RESULT_OK (1)");
      }
      return phase === 4 ? 0 : result as number;
    } finally {
      frame.active = false;
      this.frames.pop();
    }
  }

  release(id: number): void {
    const registration = this.registrations.get(id >>> 0);
    if (!registration) return;
    registration.owner.alive = false;
    this.registrations.delete(id >>> 0);
  }

  clear(): void {
    for (const id of this.registrations.keys()) this.release(id);
  }
}
