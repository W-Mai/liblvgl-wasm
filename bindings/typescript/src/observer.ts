import type { UnsafePointer } from "../../../target/typescript/raw.ts";

export type ObserverCallback = (observer: Observer, subject: UnsafePointer) => void;

/** @internal */
export interface ObserverExports {
  lvw_observer_create?(subject: number, target: number, userData: number, id: number, mode: number): number;
  lvw_observer_delete?(observer: number, id: number): number;
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
  subject: number;
  handle: number;
  phase: "creating" | "active" | "released";
}

interface Registration {
  owner: Lifetime;
  observer: Observer;
  callback: ObserverCallback;
}

/** A synchronous native subscription. Native deletion, shutdown, and guest failure invalidate its handle. */
export class Observer {
  /** @internal Use the runtime's observe methods. */
  constructor(private readonly registry: ObserverRegistry) {}

  get handle(): UnsafePointer { return this.registry.handle(this); }

  /** Cancel an ordinary subscription. Object-bound subscriptions require object or subject cleanup. */
  cancel(): void { this.registry.cancel(this); }
}

/** @internal */
export class ObserverRegistry {
  private readonly registrations = new Map<number, Registration>();
  private readonly references = new WeakMap<Observer, Lifetime>();

  constructor(private readonly core: ObserverExports, private readonly host: Host) {}

  create(subject: number, target: number, callback: ObserverCallback, userData: number, mode: number): Observer {
    this.host.ensureActive();
    for (const [name, value] of [["subject", subject], ["target", target], ["userData", userData]] as const) {
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff || (name === "subject" && value === 0)) {
        throw new RangeError(`${name} must be ${name === "subject" ? "a nonzero" : "an"} unsigned 32-bit pointer`);
      }
    }
    if (typeof callback !== "function") throw new TypeError("observer callback is required");
    for (const name of ["lvw_observer_create", "lvw_observer_delete"] as const) {
      if (typeof this.core[name] !== "function") {
        throw new Error(`missing Wasm function: ${name} (required for observer callbacks)`);
      }
    }
    const id = this.host.allocateId();
    const owner: Lifetime = { id, subject, handle: 0, phase: "creating" };
    const observer = new Observer(this);
    this.references.set(observer, owner);
    this.registrations.set(id, { owner, observer, callback });
    try {
      const pointer = this.core.lvw_observer_create!(subject, target, userData, id, mode) >>> 0;
      if (!pointer) throw new Error("lvw_observer_create failed");
      if (owner.phase !== "released") {
        if (owner.handle !== pointer) {
          this.host.poison(new Error("LVGL observer creation returned a different pointer"));
        }
        owner.handle = pointer;
        owner.phase = "active";
      }
      return observer;
    } catch (error) {
      this.release(id);
      throw error;
    }
  }

  handle(observer: Observer): UnsafePointer {
    this.host.ensureActive();
    const owner = this.references.get(observer);
    if (!owner || owner.phase === "released" || !owner.handle) {
      throw new Error("invalid LVGL observer reference");
    }
    return owner.handle;
  }

  cancel(observer: Observer): void {
    const owner = this.references.get(observer);
    if (!owner) throw new Error("invalid LVGL observer reference");
    if (owner.phase === "released") return;
    if (this.host.ready()) {
      const status = this.core.lvw_observer_delete!(owner.handle, owner.id);
      if (status !== 0) throw new Error(`lvw_observer_delete failed (${status})`);
    }
    this.release(owner.id);
  }

  dispatch(id: number, pointer: number, subject: number): void {
    this.host.rethrowFailure();
    if (this.host.closing()) return;
    this.host.ensureActive();
    const registration = this.registrations.get(id >>> 0);
    pointer >>>= 0;
    subject >>>= 0;
    if (!registration || !pointer || registration.owner.subject !== subject) {
      throw new Error("invalid LVGL observer callback");
    }
    const owner = registration.owner;
    if (!owner.handle && owner.phase === "creating") owner.handle = pointer;
    if (owner.handle !== pointer) throw new Error("LVGL observer callback pointer mismatch");
    const result: unknown = registration.callback(registration.observer, subject);
    if (result !== null && (typeof result === "object" || typeof result === "function")
        && typeof (result as { then?: unknown }).then === "function") {
      void Promise.resolve(result).catch(() => {});
      this.host.rethrowFailure();
      throw new Error("LVGL observer callbacks must finish synchronously; thenables are not supported");
    }
    this.host.rethrowFailure();
  }

  release(id: number): void {
    const registration = this.registrations.get(id >>> 0);
    if (!registration) return;
    registration.owner.phase = "released";
    this.registrations.delete(id >>> 0);
  }

  clear(): void {
    for (const id of this.registrations.keys()) this.release(id);
  }
}
