import { animationExecModuleBytes } from "../../../target/typescript/raw.ts";

export interface AnimationCallbacks {
  exec(animation: Animation, value: number): void;
  path?(animation: Animation): number;
  getValue?(animation: Animation): number;
  start?(animation: Animation): void;
  completed?(animation: Animation): void;
  deleted?(animation: Animation): void;
}

/** @internal */
export interface AnimationExports {
  __indirect_function_table?: WebAssembly.Table;
  lvw_anim_start?(descriptor: number, id: number, slot: number, flags: number): number;
  lvw_anim_delete?(animation: number, id: number): number;
  lvw_anim_exec?(slot: number, variable: number, value: number): void;
}

interface Host {
  ensureActive(): void;
  rethrowFailure(): void;
  poison(error: unknown): never;
  ready(): boolean;
  closing(): boolean;
  inGuest(): boolean;
  allocateId(): number;
}

interface Lifetime {
  id: number;
  slot: number;
  handle: number;
  phase: "creating" | "active" | "finishing" | "released";
}

interface Registration {
  owner: Lifetime;
  animation: Animation;
  callbacks: AnimationCallbacks;
}

/** A managed native animation. Completion, deletion, shutdown, and guest failure invalidate its handle. */
export class Animation {
  /** @internal Use LvglRuntime.startAnimation(). */
  constructor(private readonly registry: AnimationRegistry) {}

  get handle(): number { return this.registry.handle(this); }
  cancel(): void { this.registry.cancel(this); }
}

/** @internal */
export class AnimationRegistry {
  private readonly registrations = new Map<number, Registration>();
  private readonly references = new WeakMap<Animation, Lifetime>();
  private readonly wrappers = new Map<number, WebAssembly.ExportValue>();
  private readonly freeSlots: number[] = [];
  private readonly pendingSlots: number[] = [];
  private module?: WebAssembly.Module;
  private table?: WebAssembly.Table;
  private callbackDepth = 0;

  constructor(
    private readonly core: AnimationExports,
    private readonly dispatch: AnimationExports["lvw_anim_exec"],
    private readonly host: Host,
  ) {}

  get inCallback(): boolean { return this.callbackDepth !== 0; }

  start(descriptor: number, callbacks: AnimationCallbacks): Animation {
    this.host.ensureActive();
    if (!Number.isInteger(descriptor) || descriptor <= 0 || descriptor > 0xffffffff) {
      throw new RangeError("animation descriptor must be a nonzero unsigned 32-bit pointer");
    }
    if (!callbacks || typeof callbacks.exec !== "function") {
      throw new TypeError("animation exec callback is required");
    }
    const captured = {
      exec: callbacks.exec, path: callbacks.path, getValue: callbacks.getValue,
      start: callbacks.start, completed: callbacks.completed, deleted: callbacks.deleted,
    };
    let flags = 0;
    for (const [bit, name] of (["path", "getValue", "start", "completed", "deleted"] as const).entries()) {
      if (captured[name] === undefined) continue;
      if (typeof captured[name] !== "function") throw new TypeError(`animation ${name} must be a function`);
      flags |= 1 << bit;
    }
    for (const name of ["lvw_anim_start", "lvw_anim_delete", "lvw_anim_exec"] as const) {
      if (typeof this.core[name] !== "function") {
        throw new Error(`missing Wasm function: ${name} (required for animation callbacks)`);
      }
    }
    if (!(this.core.__indirect_function_table instanceof WebAssembly.Table)) {
      throw new Error("missing Wasm table: __indirect_function_table (required for animation callbacks)");
    }
    this.table = this.core.__indirect_function_table;
    const id = this.host.allocateId();
    const slot = this.reserveSlot();
    const owner: Lifetime = { id, slot, handle: 0, phase: "creating" };
    const animation = new Animation(this);
    this.references.set(animation, owner);
    this.registrations.set(id, { owner, animation, callbacks: captured });
    try {
      const pointer = this.core.lvw_anim_start!(descriptor, id, slot, flags) >>> 0;
      if (!pointer) throw new Error("lvw_anim_start failed");
      if (owner.phase !== "released") {
        if (owner.handle && owner.handle !== pointer) {
          this.host.poison(new Error("LVGL animation creation returned a different pointer"));
        }
        owner.handle = pointer;
        if (owner.phase === "creating") owner.phase = "active";
      }
      return animation;
    } catch (error) {
      this.release(id);
      throw error;
    }
  }

  handle(animation: Animation): number {
    this.host.ensureActive();
    const owner = this.references.get(animation);
    if (!owner || owner.phase === "released" || !owner.handle) {
      throw new Error("invalid LVGL animation reference");
    }
    return owner.handle;
  }

  cancel(animation: Animation): void {
    const owner = this.references.get(animation);
    if (!owner) throw new Error("invalid LVGL animation reference");
    if (owner.phase === "released" || owner.phase === "finishing") return;
    if (!this.host.ready()) {
      this.release(owner.id);
      return;
    }
    const status = this.core.lvw_anim_delete!(owner.handle, owner.id);
    if (status !== 0) throw new Error(`lvw_anim_delete failed (${status})`);
    this.release(owner.id);
  }

  exec(id: number, pointer: number, value: number): void {
    this.host.ensureActive();
    const registration = this.registration(id, pointer);
    this.call(registration, registration.callbacks.exec, value);
  }

  query(id: number, pointer: number, kind: number): number {
    this.host.ensureActive();
    const registration = this.registration(id, pointer);
    const callback = kind === 1 ? registration.callbacks.path
      : kind === 2 ? registration.callbacks.getValue : undefined;
    if (!callback) throw new Error("invalid LVGL animation query");
    const value = this.call(registration, callback);
    if (typeof value !== "number" || !Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
      throw new RangeError("LVGL animation query must return a signed 32-bit integer");
    }
    return value;
  }

  notify(id: number, pointer: number, kind: number): void {
    this.host.rethrowFailure();
    if (this.host.closing() && !this.registrations.has(id >>> 0)) return;
    const registration = this.registration(id, pointer);
    if (kind === 2 || kind === 3) registration.owner.phase = "finishing";
    const callback = kind === 1 ? registration.callbacks.start
      : kind === 2 ? registration.callbacks.completed
      : kind === 3 ? registration.callbacks.deleted : undefined;
    if (!callback) throw new Error("invalid LVGL animation notification");
    this.call(registration, callback);
  }

  release(id: number): void {
    const registration = this.registrations.get(id >>> 0);
    if (!registration) return;
    registration.owner.phase = "released";
    this.registrations.delete(id >>> 0);
    this.table!.set(registration.owner.slot, null);
    this.recycleSlot(registration.owner.slot);
  }

  clear(): void {
    for (const id of this.registrations.keys()) this.release(id);
  }

  settle(): void {
    if (this.host.inGuest()) return;
    for (const slot of this.pendingSlots) this.freeSlots.push(slot);
    this.pendingSlots.length = 0;
  }

  private registration(id: number, pointer: number): Registration {
    this.host.rethrowFailure();
    const registration = this.registrations.get(id >>> 0);
    pointer >>>= 0;
    if (!registration || !pointer) throw new Error("invalid LVGL animation callback");
    const owner = registration.owner;
    if (owner.handle === 0 && owner.phase === "creating") owner.handle = pointer;
    if (owner.handle !== pointer) throw new Error("LVGL animation callback pointer mismatch");
    return registration;
  }

  private call(registration: Registration, callback: (animation: Animation, value: number) => unknown,
               value = 0): unknown {
    this.host.rethrowFailure();
    this.callbackDepth++;
    try {
      const result = callback(registration.animation, value);
      if (result !== null && (typeof result === "object" || typeof result === "function")
          && typeof (result as { then?: unknown }).then === "function") {
        void Promise.resolve(result).catch(() => {});
        this.host.rethrowFailure();
        throw new Error("LVGL animation callbacks must finish synchronously; thenables are not supported");
      }
      this.host.rethrowFailure();
      return result;
    } finally {
      this.callbackDepth--;
    }
  }

  private reserveSlot(): number {
    this.module ??= new WebAssembly.Module(Uint8Array.from(animationExecModuleBytes));
    const slot = this.freeSlots.pop() ?? this.table!.grow(1, null);
    try {
      let wrapper = this.wrappers.get(slot);
      if (!wrapper) {
        const instance = new WebAssembly.Instance(this.module, {
          core: {
            dispatch: this.dispatch!,
            slot: new WebAssembly.Global({ value: "i32", mutable: false }, slot | 0),
          },
        });
        wrapper = instance.exports.exec;
        if (typeof wrapper !== "function") throw new Error("missing animation exec wrapper");
        this.wrappers.set(slot, wrapper);
      }
      this.table!.set(slot, wrapper);
      return slot;
    } catch (error) {
      this.recycleSlot(slot);
      throw error;
    }
  }

  private recycleSlot(slot: number): void {
    if (this.host.inGuest()) this.pendingSlots.push(slot);
    else this.freeSlots.push(slot);
  }
}
